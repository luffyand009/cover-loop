const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

// MongoDB & API Configurations
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";
const LEAD_COLLECTION = "payme";
const RESPONSE_COLLECTION = "turantpaisa_responses";

// Turant Paisa Endpoint & Partner ID
const TURANT_API_URL = "https://api.turantpaisa.in/partner/insert-data"; //[cite: 20]
const PARTNER_ID = "Keshvacredit"; //[cite: 20]
const UTM_SOURCE = "keshvacredit_web"; //[cite: 20]
const LENDER_NAME = "turantpaisa";

// Pincode file load karne ke liye (Excel check)
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

// Validation function as per Turant Paisa rules
function shouldSkip(lead) {
  // Required fields check: phone and pan are mandatory
  if (!lead.phone || !lead.pan) return "MISSING_REQUIRED_FIELD";

  // Phone regex check: Exactly 10 digits, must start with 6-9[cite: 20]
  const cleanPhone = String(lead.phone).trim();
  const phoneRegex = /^[6-9]\d{9}$/; //[cite: 20]
  if (!phoneRegex.test(cleanPhone)) return "INVALID_PHONE_FORMAT";

  // PAN regex check: 10 chars, uppercase[cite: 20]
  const cleanPan = String(lead.pan).trim().toUpperCase();
  const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/; //[cite: 20]
  if (!panRegex.test(cleanPan)) return "INVALID_PAN_FORMAT";

  // Excel Pincode Validation (if pincode is present)
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

  // Strict Schema Payload (Unknown/extra fields are rejected with HTTP 412)[cite: 21]
  const payload = {
    phone: String(item.phone).trim(), //[cite: 20]
    pan: String(item.pan).trim().toUpperCase(), //[cite: 20]
    partner_id: PARTNER_ID, //[cite: 20]
    utm_source: UTM_SOURCE, //[cite: 20]
    name: item.name ? String(item.name).trim() : "", //[cite: 20]
    email: item.email ? String(item.email).trim() : "", //[cite: 20]
    dob: item.dob ? String(item.dob).split("T")[0] : "", //[cite: 20]
    employment_type: item.employment || "Salaried", //[cite: 20]
    pincode: item.pincode ? String(item.pincode).trim() : "", //[cite: 21]
    state: item.state ? String(item.state).trim() : "", //[cite: 20]
    city: item.city ? String(item.city).trim() : "", //[cite: 21]
    income: item.income ? Number(item.income) : 0, //[cite: 21]
    medium: item.medium || "cpc", //[cite: 21]
    ppc_campaign: item.ppc_campaign || "personal_loan" //[cite: 21]
  };

  try {
    const res = await axios.post(TURANT_API_URL, payload, {
      headers: {
        "Content-Type": "application/json" //[cite: 20]
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

      // HTTP 409 Conflict matlab Duplicate lead hai[cite: 22, 23]
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
        log("INFO", `🚀 Processing batch of ${batch.length} leads for Turant Paisa...`);
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