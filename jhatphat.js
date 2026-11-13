const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
require("dotenv").config();

const MONGO_URI = process.env.MONGO_URI_COVER;
const DB_NAME = "coverloop";

const LEAD_COLLECTION = "keshvadb";
const RESPONSE_COLLECTION = "jhatpat_response"; // Jo aapke compass me dikh raha hai

const BASE_URL = 'https://apilm.jhatpatcash.com/api/v1/marketplace/covermantra';
const AUTH_HEADER = 'cGtfMkQ0QkZBQzA2MUQwRUEwMUI1NTA0NjBFQjg5NUIxQTQ6c2tfMjNhYzBiZjI4OTEzYmMzZGY0OTliMjcxYzlhNGE2YTg5NWE3MmI2OTNhZTk1ZDI4NTkyNDA4ZWIwNWQ1MTdjZA==';
const LENDER_NAME = "covermantra_marketplace";

const PINCODE_FILE_PATH = path.join(__dirname, "xlsx", "jhatphat.xlsx");

const REQUEST_TIMEOUT = 15000;
const MAX_SUCCESS_LIMIT = 10; // Sirf 10 successful leads ke baad ruk jayega

// Excel se Pincode Load karne ka function
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

async function run() {
  if (allowedPincodes.size === 0) {
    console.log("❌ No pincodes loaded from Excel. Please check path: xlsx/creditnow.xlsx");
    return;
  }

  const client = new MongoClient(MONGO_URI);
  
  try {
    await client.connect();
    console.log("✅ MongoDB Connected Successfully");
    
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
    let successCount = 0;
    let totalScanned = 0;

    for await (const lead of cursor) {
      if (successCount >= MAX_SUCCESS_LIMIT) {
        console.log(`\n🎉 Target reached: 10 successful leads created. Stopping script.`);
        break;
      }

      totalScanned++;
      const mobile = String(lead.phone || lead.mobile || "").trim();
      const pan = String(lead.pancard || lead.pan || "").toUpperCase().trim();
      const pincode = String(lead.pincode || "").trim();

      // Pincode Check from Excel List
      if (!allowedPincodes.has(pincode)) {
        console.log(`[${totalScanned}] ⚠️ Skipping lead ${mobile}: Pincode ${pincode} not in Excel list.`);
        await leadCol.updateOne(
          { _id: lead._id },
          { $addToSet: { processed: `${LENDER_NAME}: skipped_invalid_pincode` } }
        );
        continue;
      }

      if (!mobile || !pan) {
        console.log(`[${totalScanned}] ⚠️ Skipping lead: Missing phone or pan`);
        continue;
      }

      console.log(`\n[Processing ${successCount + 1}/10] Mobile: ${mobile} | PAN: ${pan} | Pin: ${pincode}`);

      try {
        // 1. Dedupe API Call
        const dedupeRes = await axios.post(`${BASE_URL}/dedupe`, {
          mobile: mobile,
          pancard: pan
        }, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-credential': AUTH_HEADER
          },
          timeout: REQUEST_TIMEOUT
        });

        if (dedupeRes.data && dedupeRes.data.message === 'Dedup Fail') {
          console.log(`🛑 Dedupe Fail: Already existing customer.`);
          await leadCol.updateOne(
            { _id: lead._id },
            { $addToSet: { processed: `${LENDER_NAME}: dedupe_failed` } }
          );
          continue;
        }

        await new Promise(r => setTimeout(r, 500));

        // 2. Lead Create API Call
        const leadPayload = {
          customer_email: lead.email || 'customer@covermantra.com',
          mobile_number: mobile,
          pancard: pan,
          loan_purpose: 'Personal Loan',
          employee_type: lead.employment_type || lead.employment || 'Salaried',
          salary_mode: 'Bank Transfer',
          monthly_income: Number(lead.monthly_income || lead.income) || 45000,
          salary_date: Number(lead.salary_date) || 5,
          pincode: pincode,
          consent: true,
          consent_date_time: new Date().toISOString()
        };

        const leadRes = await axios.post(`${BASE_URL}/lead_create`, leadPayload, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-credential': AUTH_HEADER
          },
          timeout: REQUEST_TIMEOUT
        });

        if (leadRes.data && leadRes.data.success && leadRes.data.data) {
          const data = leadRes.data.data;
          console.log(`✅ Success! LeadID: ${data.leadID}`);

          await responseCol.insertOne({
            userId: lead._id,
            phone: mobile,
            pan: pan,
            name: lead.name || "",
            status: "SUCCESS",
            leadID: data.leadID,
            customerID: data.customerID,
            breDecision: data.breDecision,
            offeredAmount: data.offeredAmount || 0,
            redirectUrl: data.redirectUrl,
            createdAt: new Date()
          });

          await leadCol.updateOne(
            { _id: lead._id },
            { 
              $set: { status: 'lead_created' },
              $addToSet: { processed: `${LENDER_NAME}: lead_created` } 
            }
          );

          successCount++;
        }

      } catch (err) {
        const errorMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        console.log(`❌ Error: ${errorMsg}`);
        
        await leadCol.updateOne(
          { _id: lead._id },
          { $addToSet: { processed: `${LENDER_NAME}: failed` } }
        );
      }
    }

    console.log(`\n================ SUMMARY ================`);
    console.log(`Total Scanned: ${totalScanned}`);
    console.log(`Successful Leads Created: ${successCount}`);
    console.log(`=========================================`);

    await client.close();
    console.log("🔒 MongoDB connection closed");

  } catch (err) {
    console.error(`Fatal error: ${err.message}`);
    if (client) await client.close();
  }
}

run();