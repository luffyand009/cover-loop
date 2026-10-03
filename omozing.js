const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
require("dotenv").config();

// --- CONFIGURATION & CREDENTIALS --- //
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";
const LEAD_COLLECTION = "smcoll";
const RESPONSE_COLLECTION = "aparampaar_responses";
const LENDER_NAME = "aparampaar";

// Endpoint as per Aparampaar API Documentation
const LEAD_API_URL = "https://us-central1-omozing-app-3968d.cloudfunctions.net/apiv2/app/pushlead";

// Exact Credentials & Referral Code Provided
const X_USER_ID = "CoverMantra$3214";
const X_API_KEY = "L5AYE43I55WZDOID";
const REFERRAL_CODE = "COVERMANTRA01";

// Major Cities Priority List (Inhe sabse pehle priority milegi)
const PRIORITY_CITIES = [
  "mumbai", "delhi", "bangalore", "hyderabad", 
  "pune", "chennai", "kolkata", "gurgaon", "noida", "coimbatore"
];

// --- AGE CALCULATOR ---
function calculateAge(dobString) {
  if (!dobString) return null;
  try {
    const dob = new Date(dobString);
    if (isNaN(dob.getTime())) return null;
    const diffMs = Date.now() - dob.getTime();
    return Math.abs(new Date(diffMs).getUTCFullYear() - 1970);
  } catch (e) {
    return null;
  }
}

// --- VALIDATION RULES ---
function shouldSkip(lead) {
  const required = ["phone", "pan", "pincode", "dob", "employment", "income", "name"];
  for (const field of required) {
    if (!lead[field]) return "MISSING_REQUIRED_FIELD";
  }

  // 1. Strictly Exclude Jammu & Kashmir / J&K
  const state = (lead.state || "").trim().toLowerCase();
  const pincodeStr = String(lead.pincode || "").trim();
  if (
    state.includes("jammu") || 
    state.includes("kashmir") || 
    state === "j&k" || 
    state === "jk" ||
    pincodeStr.startsWith("18") || 
    pincodeStr.startsWith("19")
  ) {
    return "EXCLUDED_STATE_JK";
  }

  // 2. Employment Type: Strictly Salaried Only
  const emp = (lead.employment || "").trim().toLowerCase();
  if (emp !== "salaried") {
    return "INVALID_EMPLOYMENT_NOT_SALARIED";
  }

  // 3. Income Validation: Between ₹60,000 and ₹1,00,000
  const incomeVal = parseFloat(lead.income || 0);
  if (isNaN(incomeVal) || incomeVal < 60000 || incomeVal > 100000) {
    return "INVALID_INCOME_RANGE_60K_1L";
  }

  // 4. Age Validation: 22 to 58 years
  const age = calculateAge(lead.dob);
  if (age === null || age < 22 || age > 58) {
    return "INVALID_AGE_RANGE";
  }

  return false;
}

// --- PAYLOAD BUILDER ---
function buildPayload(lead) {
  const dobFormatted = lead.dob ? String(lead.dob).split("T")[0] : "1990-05-21";
  
  return {
    "full_name": String(lead.name || "John Doe").trim(),
    "mobile_number": String(lead.phone).trim(),
    "email_id": String(lead.email || "johndoe@gmail.com").trim(),
    "pan": String(lead.pan).trim().toUpperCase(),
    "salary": String(lead.income || "70000"),
    "loan_amount": String(lead.loan_amount || "150050"),
    "quality_score": String(lead.quality_score || "600"),
    "Referral_Code": REFERRAL_CODE,
    "city": String(lead.city || "Mumbai").trim(),
    "state": String(lead.state || "Maharashtra").trim(),
    "company_type": lead.company_type || "Private Limited",
    "job_type": "Salaried Professional",
    "current_work": lead.current_work || "Tech Solutions",
    "designation": lead.designation || "Software Engineer",
    "date_of_birth": dobFormatted
  };
}

// --- PROCESS LEAD ---
async function processLead(item, leadCol, responseCol) {
  const skipReason = shouldSkip(item);
  if (skipReason) {
    await leadCol.updateOne({ _id: item._id }, { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } });
    return { success: false, skipped: true };
  }

  const payload = buildPayload(item);

  try {
    const res = await axios.post(LEAD_API_URL, payload, {
      headers: {
        "Content-Type": "application/json",
        "x-api-key": X_API_KEY,
        "x-user-id": X_USER_ID
      },
      timeout: 30000
    });

    const apiResponse = res.data || {};
    const isSuccess = apiResponse.success === true;

    await responseCol.insertOne({
      phone: item.phone,
      pan: item.pan,
      income: item.income,
      status: isSuccess ? "SUCCESS" : "FAILED",
      api_response: apiResponse,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    if (isSuccess) {
      await leadCol.updateOne({ _id: item._id }, { $addToSet: { processed: LENDER_NAME } });
      console.log(`✅ Success lead processed: ${item.phone} (${item.city || 'NA'}) | Income: ${item.income}`);
      return { success: true, skipped: false };
    } else {
      console.warn(`⚠️ Lead rejected/duplicate for ${item.phone}:`, apiResponse.message);
      await leadCol.updateOne({ _id: item._id }, { $addToSet: { processed: `${LENDER_NAME}: ${apiResponse.error_code || 'FAILED'}` } });
      return { success: false, skipped: false };
    }

  } catch (err) {
    const errData = err.response ? err.response.data : { message: err.message };
    console.error(`❌ API Error for ${item.phone}:`, JSON.stringify(errData));
    
    await responseCol.insertOne({
      phone: item.phone,
      pan: item.pan,
      income: item.income,
      status: "FAILED",
      api_response: errData,
      createdAt: new Date().toISOString().slice(0, 10)
    });
    return { success: false, skipped: false };
  }
}

// --- MAIN FUNCTION WITH LIVE COUNTERS & RESUME SUPPORT ---
async function main() {
  if (!MONGO_URI) {
    console.error("❌ MONGO_URI_COVER is missing in .env file!");
    return;
  }

  const client = new MongoClient(MONGO_URI);
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB Successfully.");
    
    const db = client.db(DB_NAME);
    const leadCol = db.collection(LEAD_COLLECTION);
    const responseCol = db.collection(RESPONSE_COLLECTION);

    // Total stats tracking in smcoll
    const totalInCollection = await leadCol.countDocuments({});
    const alreadyProcessedCount = await leadCol.countDocuments({ processed: { $regex: /aparampaar/i } });
    console.log(`📊 Total Leads in '${LEAD_COLLECTION}': ${totalInCollection}`);
    console.log(`📊 Already Processed for Aparampaar: ${alreadyProcessedCount}`);
    console.log(`📊 Remaining Leads to Process: ${totalInCollection - alreadyProcessedCount}\n`);

    // Query for unprocessed leads only (Resumes automatically from where it stopped)
    const query = {
      $or: [
        { processed: { $exists: false } },
        { processed: { $not: { $regex: /aparampaar/i } } }
      ]
    };

    const leads = await leadCol.find(query).toArray();
    
    // Sort remaining leads to prioritize major cities first
    leads.sort((a, b) => {
      const cityA = (a.city || "").trim().toLowerCase();
      const cityB = (b.city || "").trim().toLowerCase();
      
      const indexA = PRIORITY_CITIES.indexOf(cityA);
      const indexB = PRIORITY_CITIES.indexOf(cityB);
      
      if (indexA !== -1 && indexB !== -1) return indexA - indexB;
      if (indexA !== -1) return -1;
      if (indexB !== -1) return 1;
      return 0;
    });

    let totalScanned = 0, processedCount = 0, skippedCount = 0, failedCount = 0;
    let batch = [];

    for (const lead of leads) {
      totalScanned++;
      batch.push(lead);

      if (batch.length === 100) {
        console.log(`\n🚀 Processing batch of 100... Progress: ${totalScanned}/${leads.length}`);
        for (const item of batch) {
          const result = await processLead(item, leadCol, responseCol);
          if (result.success) {
            processedCount++;
          } else if (result.skipped) {
            skippedCount++;
          } else {
            failedCount++;
          }
          await new Promise(r => setTimeout(r, 200));
        }
        batch = [];
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    // Process remaining batch items if any
    if (batch.length > 0) {
      console.log(`\n🚀 Processing final batch... Remaining: ${batch.length}`);
      for (const item of batch) {
        const result = await processLead(item, leadCol, responseCol);
        if (result.success) {
          processedCount++;
        } else if (result.skipped) {
          skippedCount++;
        } else {
          failedCount++;
        }
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`\n================ SUMMARY ================\n` +
                `TOTAL SCANNED THIS RUN: ${totalScanned}\n` +
                `SUCCESSFULLY PROCESSED: ${processedCount}\n` +
                `SKIPPED (VALIDATION FAILED): ${skippedCount}\n` +
                `FAILED (API ERROR / REJECTED): ${failedCount}\n` +
                `=========================================`);
    
    await client.close();
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    if (client) await client.close();
  }
}

main();