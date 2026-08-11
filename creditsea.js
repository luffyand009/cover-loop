const mongoose = require("mongoose");
const path = require("path");
const xlsx = require("xlsx");
const axios = require("axios");
require("dotenv").config();

// Configuration
const BATCH_SIZE = 50000;
const TARGET_SUCCESS = 60000;
const LENDER_NAME = "creditsea"; // Tracker label for main collection

const BASE_URL = "https://backend.creditsea.com/api/v1";
const DEDUPE_ENDPOINT = "leads/dedupe";
const CREATE_LEAD_ENDPOINT = "leads/create-lead-dsa";

const CREDITSEA_SOURCE_ID = 62687494;
const CREDITSEA_DEDUPE_API_KEY = "eyJhbGciOiJIUzI1NiJ9.eyJrZXkiOiJhcGkifQ.k9X2LpQ7sT4Zm1A";

const RESPONSE_COLLECTION_NAME = "creditseaLeadResponses";
const MONGODB_URI = process.env.MONGODB_read;

if (!MONGODB_URI) {
  console.error("❌ ERROR: MongoDB connection URI is not defined!");
  process.exit(1);
}

// Database Connection
mongoose
  .connect(MONGODB_URI)
  .then(() => {
    console.log("✅ MongoDB Connected Successfully");
    const conn = mongoose.connection;
    console.log(`🏠 Connected to Database: "${conn.name}" on host: "${conn.host}"`);
  })
  .catch((err) => {
    console.error("🚫 MongoDB Connection Error:", err);
    process.exit(1);
  });

// Main Source Collection
const UserDB = mongoose.model(
  "api_user",
  new mongoose.Schema({}, { collection: "api_user", strict: false })
);

// Separate Response Collection
const ResponseDB = mongoose.model(
  "creditseaLeadResponses",
  new mongoose.Schema({}, { collection: RESPONSE_COLLECTION_NAME, strict: false })
);

// File Path for Pincodes
const PINCODE_FILE_PATH = path.join(__dirname, "xlsx", "creditsea_pincode.xlsx");

// Headers
function getCreateLeadHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      sourceid: CREDITSEA_SOURCE_ID,
    },
  };
}

function getDedupeHeaders() {
  return {
    headers: {
      "Content-Type": "application/json",
      "x-dedupe-api-key": CREDITSEA_DEDUPE_API_KEY,
    },
  };
}

// Load Valid Pincodes from Excel
function loadValidPincodes() {
  try {
    const workbook = xlsx.readFile(PINCODE_FILE_PATH);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    
    // Convert sheet to an array of objects using headers
    const data = xlsx.utils.sheet_to_json(worksheet);

    const pincodes = new Set();
    
    data.forEach((row) => {
      // Look for 'pinCode' or common variations (case-insensitive search)
      const pinKey = Object.keys(row).find(
        (key) => key.trim().toLowerCase() === 'pincode'
      );

      if (pinKey && row[pinKey]) {
        // Clean and format pincode (e.g., handles trailing spaces or numbers)
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

// 1. Dedupe API Call
async function checkDedupe(phone) {
  try {
    const response = await axios.post(
      `${BASE_URL}/${DEDUPE_ENDPOINT}`,
      { phoneNumber: String(phone) },
      getDedupeHeaders()
    );
    return response.data;
  } catch (err) {
    const errorData = err.response?.data || { error: err.message };
    console.error(`🚫 Dedupe API check failed for ${phone}:`, errorData);
    return errorData;
  }
}

// 2. Lead Creation API Call
async function submitLeadToCreditSea(user) {
  try {
    let dobFormatted = "";
    if (user.dob) {
      const date = new Date(user.dob);
      const dd = String(date.getDate()).padStart(2, "0");
      const mm = String(date.getMonth() + 1).padStart(2, "0");
      const yyyy = date.getFullYear();
      dobFormatted = `${mm}-${dd}-${yyyy}`;
    }

    const payload = {
      first_name: user.name ? String(user.name).trim() : "",
      last_name: user.last_name || ".",
      phoneNumber: Number(user.phone),
      pan: user.pan ? String(user.pan).trim().toUpperCase() : "",
      dob: dobFormatted,
      gender: user.gender ? String(user.gender).toLowerCase() : "male",
      pincode: String(user.pincode || "").trim(),
      income: String(user.income || "0"),
      employmentType: user.employment || "Salaried", // Fixed key name spelling
    };

    const response = await axios.post(
      `${BASE_URL}/${CREATE_LEAD_ENDPOINT}`,
      payload,
      getCreateLeadHeaders()
    );

    console.log(`✅ API Response for ${user.phone}:`, response.data);
    return { success: true, data: response.data };
  } catch (err) {
    const errorData = err.response?.data || { error: err.message };
    console.error(`❌ API Error for ${user.phone}:`, errorData);
    return { success: false, data: errorData };
  }
}

// Save Full Log Helper
async function saveLeadResponse(user, apiResponse, status) {
  try {
    await ResponseDB.create({
      phone: user.phone ? String(user.phone).trim() : "",
      pan: user.pan ? String(user.pan).trim().toUpperCase() : "",
      name: user.name ? String(user.name).trim() : "",
      status: status,
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10),
    });
  } catch (err) {
    console.error(`❌ Failed to save lead response for ${user.phone || "unknown"}:`, err.message);
  }
}

// Batch Processor
async function processBatch(users, validPincodes) {
  let batchSuccessCount = 0;

  await Promise.allSettled(
    users.map(async (userDoc) => {
      try {
        const phone = userDoc.phone || "No Phone Field";
        const userPincode = String(userDoc.pincode || "").trim();
        console.log(`\n🚀 Processing Lead for user ID: ${userDoc._id} (${phone})`);

        let apiResult;
        let finalStatus = "FAILED";

        // Step 1: Pincode Check
        if (!validPincodes.has(userPincode)) {
          console.warn(`⚠️ Skipped: Pincode '${userPincode}' is not serviceable.`);
          apiResult = { status: "Skipped", reason: "Pincode Not Serviceable", pincode: userPincode };
          finalStatus = "SKIPPED";
        } else {
          // Step 2: Dedupe Check
          console.log(`🔍 Checking dedupe for ${phone}...`);
          const dedupeRes = await checkDedupe(phone);

          if (dedupeRes && dedupeRes.isPresent === true) {
            console.warn(`⚠️ Skipped: User already present in CreditSea.`);
            apiResult = { status: "Skipped", reason: "Lead already exists", dedupe: dedupeRes };
            finalStatus = "SKIPPED";
          } else {
            // Step 3: API Hit
            const res = await submitLeadToCreditSea(userDoc);
            apiResult = res.data;
            if (res.success && res.data?.message === "Lead generated successfully") {
              finalStatus = "SUCCESS";
            }
          }
        }

        await saveLeadResponse(userDoc, apiResult, finalStatus);
        console.log(`💾 Response logged to "${RESPONSE_COLLECTION_NAME}" for user: ${phone}`);

        await UserDB.updateOne(
          { _id: userDoc._id },
          {
            $addToSet: {
              processed: LENDER_NAME,
            },
          }
        );
        console.log(`✅ Database updated (marked as processed) for user: ${phone}`);

        if (finalStatus === "SUCCESS") {
          batchSuccessCount++;
          console.log(`⭐ Lead Accepted Successfully for: ${phone}`);
        }
      } catch (error) {
        console.error(`❌ Failed to process user in batch:`, error.message);
      }
    })
  );

  return batchSuccessCount;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main Function
async function main() {
  let totalRegisteredSuccessfully = 0;
  const validPincodes = loadValidPincodes();

  if (validPincodes.size === 0) {
    console.error("❌ No pincodes found. Check your Excel file.");
    process.exit(1);
  }

  console.log("🚦 Starting CreditSea lead synchronization...");
  console.log(`🎯 Target limit: ${TARGET_SUCCESS} successful leads\n`);

  try {
    if (mongoose.connection.readyState !== 1) {
      console.log("⏳ Waiting for database connection...");
      await new Promise((resolve) => mongoose.connection.once("connected", resolve));
    }

    const totalDocs = await UserDB.countDocuments({});
    console.log(`📊 Target Collection: "${UserDB.collection.name}"`);
    console.log(`📊 Total documents in source collection: ${totalDocs}`);

    while (totalRegisteredSuccessfully < TARGET_SUCCESS) {
      const users = await UserDB.find({
        $or: [
          { processed: { $exists: false } },
          { processed: { $ne: LENDER_NAME } },
        ],
      })
        .limit(BATCH_SIZE)
        .lean();

      if (users.length === 0) {
        console.log("🏁 No more unprocessed documents found.");
        break;
      }

      const batchSuccess = await processBatch(users, validPincodes);
      totalRegisteredSuccessfully += batchSuccess;

      console.log(
        `📊 Batch Completed. Total successful syncs so far: ${totalRegisteredSuccessfully}/${TARGET_SUCCESS}`
      );

      if (totalRegisteredSuccessfully < TARGET_SUCCESS) {
        await delay(1000);
      }
    }

    if (totalRegisteredSuccessfully >= TARGET_SUCCESS) {
      console.log(`\n🛑 Reached target limit of ${TARGET_SUCCESS} successful synchronizations.`);
    }

    console.log("--------------------------------------------------");
    console.log(`🎯 Execution Finished. Total Success: ${totalRegisteredSuccessfully}`);
    console.log("--------------------------------------------------");
  } catch (error) {
    console.error("❌ Fatal error in main loop:", error);
  } finally {
    await mongoose.disconnect();
    console.log("🔌 MongoDB connection closed.");
  }
}

main();