const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI_COVER;

const DB_NAME = "coverloop";
const LEAD_COLLECTION = "payme";
const RESPONSE_COLLECTION = "creditt_responses";
const LEAD_API_URL = "https://agency.ctpl.live/lead/ingest/cover_mantra";
const LENDER_NAME = "creditplus";

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
        (key) => key.trim().toLowerCase() === 'pincode' || key.trim().toLowerCase() === 'pin'
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

const BATCH_SIZE = 100;
const REQUEST_TIMEOUT = 30000;
const BATCH_DELAY = 2000;

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

// Yeh function API hit hone se pehle check karega
function shouldSkip(lead) {
  const required = ["phone", "pincode"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }

  const leadPincode = String(lead.pincode || "").trim();
  if (allowedPincodes.size > 0 && !allowedPincodes.has(leadPincode)) {
    return "EXCLUDED_PINCODE";
  }

  return false;
}

async function processLead(item, leadCol, responseCol) {
  // 🛑 API hit hone se pehle validation check
  const skipReason = shouldSkip(item);
  if (skipReason) {
    log("WARN", `Skipped lead ${item.phone || 'UNKNOWN'} due to: ${skipReason}`);
    
    // Agar _id available hai toh database me tag laga do taaki dobara fetch na ho
    if (item._id) {
      await leadCol.updateOne(
        { _id: item._id }, 
        { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } }
      );
    }
    return false;
  }

  const payload = {
    phoneNumber: String(item.phone).trim(),
    panNumber: item.pan ? String(item.pan).trim() : "",
    data: {
      email: item.email || "",
      customer_name: item.name || "",
      dob: item.dob ? String(item.dob).split("T")[0] : "",
      emp_type: item.employment || "organic",
      salary: String(item.income || "0"),
      address: item.address || "",
      city: item.city || "",
      pincode: item.pincode || ""
    }
  };

  try {
    const res = await axios.post(LEAD_API_URL, payload, { timeout: REQUEST_TIMEOUT });
    const apiResponse = res.data || {};
    
    const formattedApiResponse = {
      status: apiResponse.status !== undefined ? apiResponse.status : (apiResponse.message === "SUCCESS" || apiResponse.message === "DUPLICATE"),
      message: apiResponse.message || "UNKNOWN",
      data: apiResponse.data || {}
    };

    const isSuccess = formattedApiResponse.message === "SUCCESS" || formattedApiResponse.message === "DUPLICATE";
    const responseStatusTag = formattedApiResponse.message;

    await responseCol.insertOne({
      phone: item.phone,
      name: item.name || "",
      pan: item.pan || "",
      status: isSuccess ? responseStatusTag : "FAILED",
      api_response: formattedApiResponse,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    await leadCol.updateOne(
      { _id: item._id }, 
      { $addToSet: { processed: `${LENDER_NAME}: ${responseStatusTag}` } }
    );
    
    if (responseStatusTag === "DUPLICATE") {
      log("WARN", `Duplicate lead recorded: ${item.phone}`);
    } else {
      log("INFO", `Successfully processed lead: ${item.phone}`);
    }
    return true;
  } catch (err) {
    if (err.response) {
      const errData = err.response.data;
      if (typeof errData === 'object' && errData !== null) {
        const formattedApiResponse = {
          status: errData.status !== undefined ? errData.status : false,
          message: errData.message || "ERROR",
          data: errData.data || {}
        };

        const errorStatusTag = formattedApiResponse.message;

        if (errorStatusTag === "DUPLICATE") {
          await responseCol.insertOne({
            phone: item.phone,
            name: item.name || "",
            pan: item.pan || "",
            status: "DUPLICATE",
            api_response: formattedApiResponse,
            createdAt: new Date().toISOString().slice(0, 10)
          });
          
          await leadCol.updateOne(
            { _id: item._id }, 
            { $addToSet: { processed: `${LENDER_NAME}: DUPLICATE` } }
          );
          
          log("WARN", `Duplicate lead handled from error response: ${item.phone}`);
          return true;
        }

        await leadCol.updateOne(
          { _id: item._id }, 
          { $addToSet: { processed: `${LENDER_NAME}: ERROR_${errorStatusTag}` } }
        );

        log("ERROR", `API Error for lead ${item.phone}: ${JSON.stringify(errData)}`);
      } else {
        await leadCol.updateOne(
          { _id: item._id }, 
          { $addToSet: { processed: `${LENDER_NAME}: ERROR_HTML_OR_STRING` } }
        );
        log("ERROR", `Failed for lead ${item.phone} with status/HTML: ${errData}`);
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
        { processed: { $not: { $regex: new RegExp(LENDER_NAME, "i") } } }
      ]
    };

    const cursor = leadCol.find(query);
    let total = 0, processed = 0;
    let batch = [];

    for await (const lead of cursor) {
      total++;
      batch.push(lead);

      if (batch.length === BATCH_SIZE) {
        log("INFO", `🚀 Processing batch of ${batch.length} leads...`);
        for (const item of batch) {
          const success = await processLead(item, leadCol, responseCol);
          if (success) processed++;
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
        if (success) processed++;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    log("INFO", `----- SUMMARY -----\nTOTAL FETCHED: ${total}\nPROCESSED: ${processed}`);
    await client.close();
  } catch (err) {
    log("ERROR", `Fatal error: ${err.message}`);
    if (client) await client.close();
  }
}

main();