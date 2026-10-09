const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

// MongoDB aur API Configurations
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";
const LEAD_COLLECTION = "payme";
const RESPONSE_COLLECTION = "paytrust_responses";

// PayTrust API Endpoints & Credentials
const PAYTRUST_API_URL = "https://api-backend.paytrust.co.in/partner/submit-lead";
const PARTNER_ID = "KeshvaCredit";
const API_KEY = "6501f3f8da056cab5159004b56467cca09ce6453fb2311a60072bac5f29544dc";
const LENDER_NAME = "paytrust";

// Restricted States as per PayTrust Credit Policy
const RESTRICTED_STATES = [
  "assam", "manipur", "jammu and kashmir", "meghalaya", 
  "arunachal pradesh", "mizoram", "nagaland", "tripura", "sikkim", "west bengal"
];

// Pincode file load karne ke liye (Paytrust.xlsx)
const PINCODE_FILE_PATH = path.join(__dirname, "xlsx", "Paytrust.xlsx");

function loadValidPincodes() {
  try {
    const workbook = XLSX.readFile(PINCODE_FILE_PATH);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(worksheet);
    const pincodes = new Set();
    
    data.forEach((row) => {
      const pinKey = Object.keys(row).find(
        (key) => key.trim().toLowerCase() === 'pincode' || key.trim().toLowerCase() === 'pin'
      );
      if (pinKey && row[pinKey]) {
        const cleanPin = String(row[pinKey]).trim();
        if (cleanPin) pincodes.add(cleanPin);
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

const BATCH_SIZE = 100;
const REQUEST_TIMEOUT = 30000;
const BATCH_DELAY = 2000;

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

// Age calculate karne ke liye helper function (21 to 60 years)
function calculateAge(dob) {
  if (!dob) return 0;
  const birthDate = new Date(dob);
  const today = new Date();
  let age = today.getFullYear() - birthDate.getFullYear();
  const m = today.getMonth() - birthDate.getMonth();
  if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
}

// Validation function as per PayTrust Credit Policy & Excel Pincodes
function shouldSkip(lead) {
  if (!lead.phone || !lead.pan) return "MISSING_REQUIRED_FIELD";

  const cleanPhone = String(lead.phone).trim();
  const phoneRegex = /^[6-9]\d{9}$/;
  if (!phoneRegex.test(cleanPhone)) return "INVALID_PHONE_FORMAT";

  const cleanPan = String(lead.pan).trim().toUpperCase();
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
  if (!panRegex.test(cleanPan)) return "INVALID_PAN_FORMAT";

  // 1. Age Check (21 to 60 years)[cite: 9]
  if (lead.dob) {
    const age = calculateAge(lead.dob);
    if (age < 21 || age > 60) {
      return "INVALID_AGE";
    }
  } else {
    return "MISSING_DOB";
  }

  // 2. Employment Type Check (Salaried, Self-employed, Business Owners)[cite: 9]
  const validEmployment = ["salaried", "self-employed", "business", "self_employed", "business owner"];
  if (lead.employment) {
    const empType = String(lead.employment).trim().toLowerCase();
    const isAllowed = validEmployment.some(v => empType.includes(v));
    if (!isAllowed) {
      return "INVALID_EMPLOYMENT";
    }
  }

  // 3. Minimum Monthly Salary Check (>= ₹20,000)[cite: 9]
  if (lead.income !== undefined && lead.income !== null) {
    if (Number(lead.income) < 20000) {
      return "LOW_INCOME";
    }
  } else {
    return "MISSING_INCOME";
  }

  // 4. State & Geographic Restriction Check (with West Bengal Kolkata exception)[cite: 9]
  if (lead.state) {
    const stateName = String(lead.state).trim().toLowerCase();
    if (RESTRICTED_STATES.includes(stateName)) {
      if (stateName === "west bengal") {
        const pincode = String(lead.pincode || "").trim();
        const kolkataPincodes = /^700/;
        if (!kolkataPincodes.test(pincode)) {
          return "RESTRICTED_STATE_PINCODE";
        }
      } else {
        return "RESTRICTED_STATE";
      }
    }
  }

  // 5. Excel Pincode Verification
  if (lead.pincode) {
    const leadPincode = String(lead.pincode).trim();
    if (allowedPincodes.size > 0 && !allowedPincodes.has(leadPincode)) {
      return "EXCLUDED_PINCODE";
    }
  }

  return false;
}

async function processLead(item, leadCol, responseCol) {
  const skipReason = shouldSkip(item);
  if (skipReason) {
    log("WARN", `Skipped lead ${item.phone || 'UNKNOWN'} due to: ${skipReason}`);
    if (item._id) {
      await leadCol.updateOne(
        { _id: item._id }, 
        { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } }
      );
    }
    return false;
  }

  const payload = {
    partner_id: PARTNER_ID,
    phone: String(item.phone).trim(),
    pan: String(item.pan).trim().toUpperCase(),
    utm_source: PARTNER_ID,
    name: item.name ? String(item.name).trim() : "",
    email: item.email ? String(item.email).trim() : "",
    dob: item.dob ? String(item.dob).split("T")[0] : "",
    employment_type: item.employment || "salaried",
    pincode: item.pincode ? String(item.pincode).trim() : "",
    state: item.state ? String(item.state).trim() : "",
    city: item.city ? String(item.city).trim() : "",
    income: item.income ? Number(item.income) : undefined,
    medium: item.medium || "cpc",
    ppc_campaign: item.ppc_campaign || "personal_loan"
  };

  try {
    const res = await axios.post(PAYTRUST_API_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": API_KEY
      },
      timeout: REQUEST_TIMEOUT
    });

    const apiResponse = res.data || {};
    
    await responseCol.insertOne({
      phone: item.phone,
      name: item.name || "",
      pan: item.pan || "",
      status: "SUCCESS",
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    await leadCol.updateOne(
      { _id: item._id }, 
      { $addToSet: { processed: `${LENDER_NAME}: SUCCESS` } }
    );

    log("INFO", `Successfully processed lead: ${item.phone}`);
    return true;

  } catch (err) {
    if (err.response) {
      const statusCode = err.response.status;
      const errData = err.response.data || {};
      const errorMessage = errData.message || "ERROR";

      if (statusCode === 409) {
        await responseCol.insertOne({
          phone: item.phone,
          name: item.name || "",
          pan: item.pan || "",
          status: "DUPLICATE",
          api_response: errData,
          createdAt: new Date().toISOString().slice(0, 10)
        });

        await leadCol.updateOne(
          { _id: item._id }, 
          { $addToSet: { processed: `${LENDER_NAME}: DUPLICATE` } }
        );

        log("WARN", `Duplicate lead handled for ${item.phone}: ${errorMessage}`);
        return true;
      }

      await responseCol.insertOne({
        phone: item.phone,
        name: item.name || "",
        pan: item.pan || "",
        status: "FAILED",
        api_response: errData,
        createdAt: new Date().toISOString().slice(0, 10)
      });

      await leadCol.updateOne(
        { _id: item._id }, 
        { $addToSet: { processed: `${LENDER_NAME}: ERROR_${statusCode}_${errorMessage}` } }
      );

      log("ERROR", `API Error (${statusCode}) for lead ${item.phone}: ${JSON.stringify(errData)}`);
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
        { processed: { $not: { $regex: new RegExp(LENDER_NAME, "i") } } }
      ]
    };

    const cursor = leadCol.find(query);
    let total = 0, processedCount = 0;
    let batch = [];

    for await (const lead of cursor) {
      total++;
      batch.push(lead);

      if (batch.length === BATCH_SIZE) {
        log("INFO", `🚀 Processing batch of ${batch.length} leads for PayTrust...`);
        for (const item of batch) {
          const success = await processLead(item, leadCol, responseCol);
          if (success) processedCount++;
          await new Promise(r => setTimeout(r, 200));
        }
        batch = [];
        await new Promise(r => setTimeout(r, BATCH_DELAY));
      }
    }

    if (batch.length > 0) {
      log("INFO", `🚀 Processing final batch of ${batch.length} leads...`);
      for (const item of batch) {
        const success = await processLead(item, leadCol, responseCol);
        if (success) processedCount++;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    log("INFO", `----- SUMMARY -----\nTOTAL FETCHED: ${total}\nPROCESSED: ${processedCount}`);
    await client.close();
  } catch (err) {
    log("ERROR", `Fatal error: ${err.message}`);
    if (client) await client.close();
  }
}

main();