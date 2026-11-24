const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI_COVER;

const DB_NAME = "coverloop";
const LEAD_COLLECTION = "payme";
const RESPONSE_COLLECTION = "mmb_responses";

const MERCHANT_ID =
  process.env.MMB_MERCHANT_ID || "ca325bfc-de04-4535-9dbf-6315fae955d2";
const MMB_API_KEY =
  process.env.MMB_API_KEY || "3a6210cc-e98e-446b-995f-c700d23c699f";

const DEDUPE_API_URL =
  "https://mm-app-backend.mymoneybazaar.com/api/authentication/check_user_merchant/";
const REGISTER_API_URL =
  "https://mm-app-backend.mymoneybazaar.com/api/authentication/register_user_merchant/";
const LEAD_STATUS_API_URL =
  "https://mm-app-backend.mymoneybazaar.com/api/merchant/lead_details/";

const LENDER_NAME = "mymoneybazaar";

const PINCODE_FILE_PATH = path.join(__dirname, "xlsx", "creditnow.xlsx");

function loadValidPincodes() {
  try {
    const workbook = XLSX.readFile(PINCODE_FILE_PATH);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const data = XLSX.utils.sheet_to_json(worksheet);
    const pincodes = new Set();

    data.forEach((row) => {
      const pinKey = Object.keys(row).find(
        (key) =>
          key.trim().toLowerCase() === "pincode" ||
          key.trim().toLowerCase() === "pin"
      );

      if (pinKey && row[pinKey]) {
        const cleanPin = String(row[pinKey]).trim();
        if (cleanPin) {
          pincodes.add(cleanPin);
        }
      }
    });

    console.log(`✅ Loaded ${pincodes.size} valid pincodes from Excel.`);
    return pincodes;
  } catch (error) {
    console.error(`❌ Error loading pincode file: ${error.message}`);
    return new Set();
  }
}

const allowedPincodes = loadValidPincodes();

const BATCH_SIZE = 5;
const REQUEST_TIMEOUT = 30000; // 30 seconds timeout as per MMB docs
const BATCH_DELAY = 2000;
const ITEM_DELAY = 550; // Keeps dedupe calls comfortably under 120 req/min per merchant_id

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

function calculateAge(lead) {
  if (lead.age !== undefined && lead.age !== null && lead.age !== "") {
    const numericAge = Number(lead.age);
    return Number.isFinite(numericAge) ? numericAge : null;
  }
  if (lead.dob) {
    const dobDate = new Date(lead.dob);
    if (!Number.isNaN(dobDate.getTime())) {
      const today = new Date();
      let age = today.getFullYear() - dobDate.getFullYear();
      const monthDiff = today.getMonth() - dobDate.getMonth();
      if (
        monthDiff < 0 ||
        (monthDiff === 0 && today.getDate() < dobDate.getDate())
      ) {
        age--;
      }
      return age;
    }
  }
  return null;
}

// API hit hone se pehle validation check (Salaried + Age 22-55 + Pincode)
function shouldSkip(lead) {
  const required = ["phone", "pincode"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }

  const leadPincode = String(lead.pincode || "").trim();
  if (allowedPincodes.size > 0 && !allowedPincodes.has(leadPincode)) {
    return "EXCLUDED_PINCODE";
  }

  const empRaw = String(lead.employment || lead.emp_type || "")
    .trim()
    .toLowerCase();
  if (empRaw !== "salaried") {
    return "NOT_SALARIED";
  }

  const age = calculateAge(lead);
  if (age === null || age < 22 || age > 55) {
    return "AGE_OUT_OF_RANGE_22_55";
  }

  return false;
}

async function processLead(item, leadCol, responseCol) {
  // 🛑 API hit hone se pehle validation check
  const skipReason = shouldSkip(item);
  if (skipReason) {
    log(
      "WARN",
      `Skipped lead ${item.phone || "UNKNOWN"} due to: ${skipReason}`
    );

    if (item._id) {
      await leadCol.updateOne(
        { _id: item._id },
        { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } }
      );
    }
    return false;
  }

  const phoneNumber = String(item.phone).trim();
  const email = item.email ? String(item.email).trim() : "";
  const fullName = item.name ? String(item.name).trim() : "Customer";

  try {
    // 1. Dedupe Check API[cite: 1]
    const dedupePayload = {
      phone_number: Number(phoneNumber),
      merchant_id: MERCHANT_ID,
      ...(email ? { email } : {}),
    };

    const dedupeRes = await axios.post(DEDUPE_API_URL, dedupePayload, {
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      timeout: REQUEST_TIMEOUT,
    });

    const dedupeData = dedupeRes.data || {};
    const dedupeMsg = String(dedupeData.message || "").toLowerCase();
    const isUserNotFound =
      dedupeMsg === "user_not_found" || dedupeMsg.includes("not found");

    // 2. User Registration API (only if user is not found)[cite: 1]
    let registerData = null;
    if (isUserNotFound) {
      const registerPayload = {
        merchant_id: MERCHANT_ID,
        email: email || `${phoneNumber}@example.com`,
        phone_number: Number(phoneNumber),
        full_name: fullName,
      };

      try {
        const regRes = await axios.post(REGISTER_API_URL, registerPayload, {
          headers: {
            accept: "application/json",
            "Content-Type": "application/json",
          },
          timeout: REQUEST_TIMEOUT,
        });
        registerData = regRes.data || {};
      } catch (regErr) {
        registerData = regErr.response?.data || { error: regErr.message };
      }
    }

    // 3. Lead Status API[cite: 1]
    let leadStatusData = null;
    try {
      const statusRes = await axios.post(
        LEAD_STATUS_API_URL,
        {
          merchant_id: MERCHANT_ID,
          phone_number: phoneNumber,
        },
        {
          headers: {
            "Content-Type": "application/json",
            "api-key": MMB_API_KEY,
          },
          timeout: REQUEST_TIMEOUT,
        }
      );
      leadStatusData = statusRes.data || {};
    } catch (statusErr) {
      leadStatusData = statusErr.response?.data || { error: statusErr.message };
    }

    const statusTag = isUserNotFound ? "REGISTERED_AND_CHECKED" : "USER_FOUND";

    await responseCol.insertOne({
      phone: item.phone,
      name: fullName,
      email,
      pan: item.pan || "",
      age: calculateAge(item),
      employment: item.employment || item.emp_type,
      status: statusTag,
      api_response: {
        dedupe: dedupeData,
        registration: registerData,
        lead_status: leadStatusData,
      },
      createdAt: new Date().toISOString().slice(0, 10),
    });

    await leadCol.updateOne(
      { _id: item._id },
      { $addToSet: { processed: `${LENDER_NAME}: ${statusTag}` } }
    );

    log("INFO", `Successfully processed lead: ${item.phone} (${statusTag})`);
    return true;
  } catch (err) {
    if (err.response) {
      const errData = err.response.data;
      if (typeof errData === "object" && errData !== null) {
        const errorStatusTag = errData.message || "ERROR";

        await leadCol.updateOne(
          { _id: item._id },
          {
            $addToSet: {
              processed: `${LENDER_NAME}: ERROR_${errorStatusTag}`,
            },
          }
        );

        log(
          "ERROR",
          `API Error for lead ${item.phone}: ${JSON.stringify(errData)}`
        );
      } else {
        await leadCol.updateOne(
          { _id: item._id },
          {
            $addToSet: {
              processed: `${LENDER_NAME}: ERROR_HTML_OR_STRING`,
            },
          }
        );
        log(
          "ERROR",
          `Failed for lead ${item.phone} with status/HTML: ${errData}`
        );
      }
    } else {
      await leadCol.updateOne(
        { _id: item._id },
        { $addToSet: { processed: `${LENDER_NAME}: ERROR_NETWORK` } }
      );
      log("ERROR", `Failed for lead ${item.phone}: ${err.message}`);
    }
    return false;
  }
}

async function main() {
  if (allowedPincodes.size === 0) {
    log("ERROR", "❌ No pincodes loaded from Excel. Aborting execution.");
    return;
  }

  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    log("INFO", "✅ MongoDB Connected Successfully");
    const db = client.db(DB_NAME);
    const leadCol = db.collection(LEAD_COLLECTION);
    const responseCol = db.collection(RESPONSE_COLLECTION);

    const query = {
      $or: [
        { processed: { $exists: false } },
        { processed: { $not: { $regex: new RegExp(LENDER_NAME, "i") } } },
      ],
    };

    const cursor = leadCol.find(query);
    let total = 0,
      processed = 0;
    let batch = [];

    for await (const lead of cursor) {
      total++;
      batch.push(lead);

      if (batch.length === BATCH_SIZE) {
        log("INFO", `🚀 Processing batch of ${batch.length} leads...`);
        for (const item of batch) {
          const success = await processLead(item, leadCol, responseCol);
          if (success) processed++;
          await new Promise((r) => setTimeout(r, ITEM_DELAY));
        }
        batch = [];
        await new Promise((r) => setTimeout(r, BATCH_DELAY));
      }
    }

    if (batch.length > 0) {
      log("INFO", `🚀 Processing final batch of ${batch.length} leads...`);
      for (const item of batch) {
        const success = await processLead(item, leadCol, responseCol);
        if (success) processed++;
        await new Promise((r) => setTimeout(r, ITEM_DELAY));
      }
    }

    log(
      "INFO",
      `----- SUMMARY -----\nTOTAL FETCHED: ${total}\nPROCESSED: ${processed}`
    );
    await client.close();
  } catch (err) {
    log("ERROR", `Fatal error: ${err.message}`);
    if (client) await client.close();
  }
}

main();