const { MongoClient } = require("mongodb");
const axios = require("axios");
const http = require("http");
const https = require("https");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

// MongoDB aur API Configurations
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";
const LEAD_COLLECTION = "payme";
const RESPONSE_COLLECTION = "mpokket_responses";

// mPokket API Endpoints & Credentials (Staging Environment)
const MPOKKET_API_URL = "https://stg-api.mpkt.in/acquisition-affiliate/v1/user";
const API_KEY = "CEF3B2C79B8745A08FF6A0B7A694D";
const LENDER_NAME = "mpokket";

// Force IPv4 for Axios to prevent Access Denied error on whitelisted IP
const axiosInstance = axios.create({
  httpAgent: new http.Agent({ family: 4 }),
  httpsAgent: new https.Agent({ family: 4 }),
  timeout: 30000
});

// Pincode file load karne ke liye
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
const BATCH_DELAY = 2000;

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

// Date format conversion YYYY-MM-DD to DD-MM-YYYY (mPokket requirement)
function formatDob(dob) {
  if (!dob) return "";
  const cleanDate = String(dob).split("T")[0];
  const parts = cleanDate.split("-");
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return cleanDate;
}

// Validation function before hitting API
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

  // mPokket Payload Structure mapping
  const payload = {
    email_id: item.email || "",
    mobile_no: String(item.phone).trim(),
    pancard: item.pan ? String(item.pan).trim() : "",
    full_name: item.name || "",
    date_of_birth: formatDob(item.dob),
    gender: item.gender ? item.gender.toLowerCase() === 'male' ? 'Male' : 'Female' : 'Male',
    profession: item.employment || "Salaried",
    additional_info: {
      net_monthly_income: String(item.income || "0"),
      current_address: item.address || "",
      current_city: item.city || "",
      current_pincode: item.pincode || "",
      current_state: item.state || ""
    }
  };

  try {
    const res = await axiosInstance.post(MPOKKET_API_URL, payload, {
      headers: {
        "api-key": API_KEY,
        "Content-Type": "application/json"
      }
    });

    const apiResponse = res.data || {};
    const isSuccess = apiResponse.success === true && apiResponse.status_code === "1200";
    const responseStatusTag = isSuccess ? "SUCCESS" : (apiResponse.message || "FAILED");

    await responseCol.insertOne({
      phone: item.phone,
      name: item.name || "",
      pan: item.pan || "",
      status: isSuccess ? "SUCCESS" : "FAILED",
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    await leadCol.updateOne(
      { _id: item._id }, 
      { $addToSet: { processed: `${LENDER_NAME}: ${responseStatusTag}` } }
    );

    if (isSuccess) {
      log("INFO", `Successfully processed lead: ${item.phone}, Request ID: ${apiResponse.data?.request_id}`);
    } else {
      log("WARN", `Lead accepted with issue/failed for ${item.phone}: ${JSON.stringify(apiResponse)}`);
    }
    return true;

  } catch (err) {
    if (err.response) {
      const errData = err.response.data || {};
      const errorMessage = Array.isArray(errData.message) ? errData.message.join(", ") : (errData.message || "ERROR");

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
        { $addToSet: { processed: `${LENDER_NAME}: ERROR_${errorMessage}` } }
      );

      log("ERROR", `API Error for lead ${item.phone}: ${JSON.stringify(errData)}`);
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
        log("INFO", `🚀 Processing batch of ${batch.length} leads for mPokket...`);
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