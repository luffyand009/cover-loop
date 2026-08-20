const { MongoClient } = require("mongodb");
const axios = require("axios");
require("dotenv").config();

// --- CONFIGURATION & CREDENTIALS --- //
const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";
const LEAD_COLLECTION = "keshvadb";
const RESPONSE_COLLECTION = "moneyview_responses";
const LENDER_NAME = "moneyview";

// Endpoints
const BASE_URL = "https://atlas.whizdm.com/atlas/v1";
const TOKEN_URL = `${BASE_URL}/token`;
const LEAD_API_URL = `${BASE_URL}/lead`;
const OFFERS_API_URL = `${BASE_URL}/offers`;

// Credentials
const PARTNER_CODE = 422;
const USERNAME = "keshvacredit";
const PASSWORD = "Zb'91O(Nhy";

// Common Headers to bypass Cloudflare bot detection
const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

// --- TOKEN MANAGEMENT --- //
let cachedToken = null;
let tokenExpiryTime = null;
const REFRESH_INTERVAL_MS = 23 * 60 * 60 * 1000; // 23 Hours

async function getAccessToken() {
  const currentTime = Date.now();
  if (cachedToken && tokenExpiryTime && currentTime < tokenExpiryTime) {
    return cachedToken;
  }

  console.log("🔑 Generating new MoneyView Auth Token...");
  try {
    const res = await axios.post(TOKEN_URL, {
      userName: USERNAME,
      password: PASSWORD,
      partnerCode: PARTNER_CODE
    }, {
      headers: COMMON_HEADERS
    });

    cachedToken = res.data?.token;
    tokenExpiryTime = Date.now() + REFRESH_INTERVAL_MS;
    console.log("✅ MoneyView Token generated successfully.");
    return cachedToken;
  } catch (err) {
    console.error("❌ Token Generation Failed:", err.response?.data || err.message);
    throw err;
  }
}

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

  // 1. Employment Type: Salaried & Self Employed dono allowed
  const emp = (lead.employment || "").trim().toLowerCase();
  const isSalaried = emp === "salaried";
  const isSelfEmployed = emp === "self employed" || emp === "selfemployed" || emp === "self-employed";
  
  if (!isSalaried && !isSelfEmployed) {
    return "INVALID_EMPLOYMENT";
  }

  // 2. Income Validation: 21,000 plus
  const incomeVal = parseFloat(lead.income || 0);
  if (isNaN(incomeVal) || incomeVal < 21000) {
    return "LOW_INCOME";
  }

  // 3. Age Validation: 21 to 60
  const age = calculateAge(lead.dob);
  if (age === null || age < 21 || age > 60) {
    return "INVALID_AGE";
  }

  return false;
}

// --- PAYLOAD BUILDER ---
function buildPayload(lead) {
  const dobFormatted = lead.dob ? String(lead.dob).split("T")[0] : "";
  const emp = (lead.employment || "").trim().toLowerCase();
  const mappedEmploymentType = (emp === "salaried") ? "salaried" : "self employed";
  
  return {
    partnerCode: PARTNER_CODE,
    partnerRef: String(lead._id),
    phone: String(lead.phone).trim(),
    pan: String(lead.pan).trim().toUpperCase(),
    name: String(lead.name).trim(),
    gender: (lead.gender || "male").toLowerCase(),
    dateOfBirth: dobFormatted,
    bureauPermission: 1,
    employmentType: mappedEmploymentType,
    incomeMode: "online",
    declaredIncome: String(lead.income || "0"),
    educationLevel: "Graduation",
    addressList: [
      {
        addressLine1: lead.address || "No Address Provided",
        addressLine2: lead.city || "",
        city: lead.city || "NA",
        state: lead.state || "NA",
        pincode: String(lead.pincode).trim(),
        addressType: "current"
      }
    ],
    emailList: [
      {
        email: lead.email || "test@example.com",
        type: "primary_device"
      }
    ],
    loanPurpose: "Travel",
    maritalStatus: "Married"
  };
}

// --- FETCH OFFERS HELPER ---
async function fetchOffers(leadId, token) {
  try {
    const offerUrl = `${OFFERS_API_URL}/${leadId}`;
    const res = await axios.get(offerUrl, {
      headers: { 
        ...COMMON_HEADERS,
        "token": token 
      }
    });
    console.log(`🎁 Offers fetched for LeadID ${leadId}:`, JSON.stringify(res.data));
    return res.data;
  } catch (err) {
    console.error(`⚠️ Could not fetch offers for LeadID ${leadId}:`, err.response?.data || err.message);
    return null;
  }
}

// --- PROCESS LEAD ---
async function processLead(item, leadCol, responseCol, token) {
  const skipReason = shouldSkip(item);
  if (skipReason) {
    await leadCol.updateOne({ _id: item._id }, { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } });
    return false;
  }

  const payload = buildPayload(item);

  try {
    const res = await axios.post(LEAD_API_URL, payload, {
      headers: {
        ...COMMON_HEADERS,
        "token": token
      },
      timeout: 30000
    });

    const apiResponse = res.data || {};
    const isSuccess = apiResponse.status === "success";
    const leadId = apiResponse.leadId || null;

    let offerData = null;
    if (isSuccess && leadId) {
      offerData = await fetchOffers(leadId, token);
    }

    await responseCol.insertOne({
      phone: item.phone,
      pan: item.pan,
      status: isSuccess ? "SUCCESS" : apiResponse.status,
      leadId: leadId,
      api_response: apiResponse,
      offer_response: offerData,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    await leadCol.updateOne({ _id: item._id }, { $addToSet: { processed: LENDER_NAME } });
    console.log(`✅ Success lead processed: ${item.phone} | LeadID: ${leadId}`);
    return true;

  } catch (err) {
    const errData = err.response ? err.response.data : { message: err.message };
    console.error(`❌ API Error for ${item.phone}:`, JSON.stringify(errData));
    
    await responseCol.insertOne({
      phone: item.phone,
      status: "FAILED",
      api_response: errData,
      createdAt: new Date().toISOString().slice(0, 10)
    });
    return false;
  }
}

// --- MAIN LOOP ---
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

    const token = await getAccessToken();

    const query = {
      $or: [
        { processed: { $exists: false } },
        { processed: { $not: { $regex: /moneyview/i } } }
      ]
    };

    const cursor = leadCol.find(query);
    let total = 0, processed = 0, skipped = 0;
    let batch = [];

    for await (const lead of cursor) {
      total++;
      batch.push(lead);

      if (batch.length === 100) {
        console.log(`🚀 Processing batch... Total scanned: ${total}`);
        for (const item of batch) {
          const success = await processLead(item, leadCol, responseCol, token);
          if (success) processed++;
          else skipped++;
          await new Promise(r => setTimeout(r, 200));
        }
        batch = [];
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (batch.length > 0) {
      for (const item of batch) {
        const success = await processLead(item, leadCol, responseCol, token);
        if (success) processed++;
        else skipped++;
        await new Promise(r => setTimeout(r, 200));
      }
    }

    console.log(`----- SUMMARY -----\nTOTAL: ${total}\nPROCESSED: ${processed}\nSKIPPED: ${skipped}`);
    await client.close();
  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    if (client) await client.close();
  }
}

main();