require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const path = require('path');
const XLSX = require('xlsx');

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const MONGO_URI = process.env.MONGO_URI_COVER || process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'coverloop';

const LEAD_COLLECTION = process.env.LEAD_COLLECTION || 'keshvadb';
const RESPONSE_COLLECTION = process.env.RESPONSE_COLLECTION || 'loandidd';

const LOANDIDI_API_KEY = process.env.LOANDIDI_API_KEY || 'ldk_live_NKYavhxhqt9Y9l6O0lLqfwHcMYjbnxlLMt2iyqMdPAU';
const BASE_URL = 'https://api.loandidi.com/api/method';

const PINCODE_FILE_PATH = process.env.PINCODE_FILE_PATH || path.join(__dirname, 'xlsx', 'LoanDidi Pincodes.xlsx');

const BATCH_SIZE = 1000;
const DELAY_BETWEEN_BATCHES_MS = 3500;

const DAILY_LIMIT = parseInt(process.argv[2] || process.env.DAILY_LIMIT || '1000', 10);

// ==========================================
// 2. AXIOS CLIENT & HELPERS
// ==========================================
const apiClient = axios.create({
  baseURL: BASE_URL,
  headers: {
    'X-LoanDidi-Key': LOANDIDI_API_KEY,
    'Content-Type': 'application/json'
  },
  timeout: 30000
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Sirf YYYY-MM-DD date string (IST) bina time ke
function getTodayDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

// Helper: Convert DD-MM-YYYY to YYYY-MM-DD if needed by API
function formatDate(dobStr) {
  if (!dobStr) return '1995-01-01';
  if (/^\d{4}-\d{2}-\d{2}$/.test(dobStr)) return dobStr;
  const parts = dobStr.split(/[-/]/);
  if (parts.length === 3 && parts[0].length === 2) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return dobStr;
}

// Excel se Pincode Load karne ka function
function loadValidPincodes(filePath) {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    const rows = XLSX.utils.sheet_to_json(worksheet);
    const pincodes = new Set();

    rows.forEach((row) => {
      const pinKey = Object.keys(row).find(
        (key) => key.trim().toLowerCase() === 'pincode' || key.trim().toLowerCase() === 'pin'
      );

      if (pinKey && row[pinKey] !== undefined && row[pinKey] !== null) {
        const cleanPin = String(row[pinKey]).trim();
        if (cleanPin) {
          pincodes.add(cleanPin);
        }
      }
    });

    console.log(`✅ Loaded ${pincodes.size} valid pincodes from ${filePath}`);
    return pincodes;
  } catch (error) {
    console.error(`❌ Error loading pincode file (${filePath}): ${error.message}`);
    return new Set();
  }
}

const allowedPincodes = loadValidPincodes(PINCODE_FILE_PATH);

// ==========================================
// 3. MAIN BATCH SYNC ENGINE
// ==========================================
async function startWorker() {
  console.log(`====================================================`);
  console.log(`🚀 LoanDidi Bulk Lead Sync Worker Initiated`);
  console.log(`🎯 Today's Quota: ${DAILY_LIMIT} leads`);
  console.log(`📦 Batch Size: ${BATCH_SIZE} leads/batch`);
  console.log(`📍 Allowed Pincodes: ${allowedPincodes.size}`);
  console.log(`📂 Database: ${DB_NAME} | Collection: ${LEAD_COLLECTION}`);
  console.log(`====================================================\n`);

  if (allowedPincodes.size === 0) {
    console.log(`❌ No pincodes loaded from Excel. Please check path: ${PINCODE_FILE_PATH}`);
    return;
  }

  const client = new MongoClient(MONGO_URI);

  try {
    console.log('🔄 Connecting to MongoDB...');
    await client.connect();
    console.log('✅ Connected to MongoDB.\n');

    const db = client.db(DB_NAME);
    const leadsCollection = db.collection(LEAD_COLLECTION);
    const responseCollection = db.collection(RESPONSE_COLLECTION);

    await leadsCollection.createIndex({ loanDidiStatus: 1, createdAt: 1 });

    let totalSyncedToday = 0;
    let totalSkippedPincode = 0;

    while (totalSyncedToday < DAILY_LIMIT) {
      const remainingQuota = DAILY_LIMIT - totalSyncedToday;
      const currentBatchLimit = Math.min(BATCH_SIZE, remainingQuota);

      // Thoda zyada fetch karte hain taaki skipped pincodes ke baad bhi eligible leads mil sakein
      const candidateUsers = await leadsCollection
        .find({ loanDidiStatus: { $in: [null, 'PENDING', 'FAILED'] } })
        .sort({ createdAt: 1 })
        .limit(currentBatchLimit * 3)
        .toArray();

      if (!candidateUsers || candidateUsers.length === 0) {
        console.log('ℹ️ No more pending leads found in Database.');
        break;
      }

      const skipOps = [];
      const eligibleUsers = [];

      for (const user of candidateUsers) {
        const pin = String(user.pincode || '').trim();
        if (!pin || !allowedPincodes.has(pin)) {
          totalSkippedPincode++;
          skipOps.push({
            updateOne: {
              filter: { _id: user._id },
              update: {
                $set: {
                  loanDidiStatus: 'SKIPPED',
                  loanDidiSkipReason: 'EXCLUDED_PINCODE',
                  syncedAt: new Date()
                }
              }
            }
          });
          continue;
        }

        eligibleUsers.push(user);
        if (eligibleUsers.length === currentBatchLimit) {
          break;
        }
      }

      if (skipOps.length > 0) {
        await leadsCollection.bulkWrite(skipOps);
        console.log(`⚠️ Skipped ${skipOps.length} leads due to pincode not in allowed list.`);
      }

      if (eligibleUsers.length === 0) {
        continue;
      }

      console.log(`⏳ Processing batch of ${eligibleUsers.length} eligible leads (Total Sent: ${totalSyncedToday}/${DAILY_LIMIT})...`);

      const leadsPayload = eligibleUsers.map((u) => ({
        partnerReference: `CM_${u._id}`,
        name: u.name,
        mobile: u.phone,
        email: u.email || 'support@covermantra.in',
        pan: u.pan,
        dob: formatDate(u.dob),
        monthly_income: Number(u.income) || 25000,
        loan_amount: u.loanAmount || 50000,
        pincode: String(u.pincode).trim(),

        employment: u.employment ? u.employment.toLowerCase() : 'salaried',
        gender: u.gender ? u.gender.toUpperCase() : 'FEMALE',

        consent: true,
        consentChannel: 'website',
        consentText: 'I agree to share my details with LoanDidi for my loan application.'
      }));

      try {
        const response = await apiClient.post('/partner.v1.leads.bulk', {
          leads: leadsPayload
        });

        const results = response.data?.results || response.data?.leads || [];

        const bulkLeadOps = [];
        const responseLogs = [];
        const todayStr = getTodayDateString();

        eligibleUsers.forEach((user, idx) => {
          const res = results[idx] || null;
          const now = new Date();
          const userMeta = {
            userId: user._id,
            name: user.name || '',
            phone: user.phone || '',
            pan: user.pan || ''
          };

          if (res && res.lead) {
            bulkLeadOps.push({
              updateOne: {
                filter: { _id: user._id },
                update: {
                  $set: {
                    loanDidiStatus: 'SUBMITTED',
                    loanDidiLeadId: res.lead,
                    loanDidiApplyLink: res.applyLink || '',
                    partnerReference: `CM_${user._id}`,
                    syncedAt: now
                  }
                }
              }
            });

            responseLogs.push({
              ...userMeta,
              leadId: res.lead,
              status: 'SUCCESS',
              response: res,
              createdAt: todayStr
            });
          } else {
            const errorMsg = res?.error?.message || 'Submission failed';
            bulkLeadOps.push({
              updateOne: {
                filter: { _id: user._id },
                update: {
                  $set: {
                    loanDidiStatus: 'FAILED',
                    loanDidiError: errorMsg,
                    syncedAt: now
                  }
                }
              }
            });

            responseLogs.push({
              ...userMeta,
              status: 'FAILED',
              error: errorMsg,
              response: res,
              createdAt: todayStr
            });
          }
        });

        if (bulkLeadOps.length > 0) {
          await leadsCollection.bulkWrite(bulkLeadOps);
        }

        if (responseLogs.length > 0) {
          await responseCollection.insertMany(responseLogs);
        }

        totalSyncedToday += eligibleUsers.length;
        console.log(`✅ Batch complete! Progress: ${totalSyncedToday}/${DAILY_LIMIT}`);

        if (totalSyncedToday >= DAILY_LIMIT) {
          break;
        }

        await sleep(DELAY_BETWEEN_BATCHES_MS);

      } catch (err) {
        const status = err.response?.status;
        const retryAfter = parseInt(err.response?.headers['retry-after'] || '10', 10);

        if (status === 429 || status === 503) {
          console.warn(`⚠️ Rate Limit / Server Busy (${status}). Backing off for ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
        } else {
          console.error('❌ Batch API Failed:', err.response?.data || err.message);

          const failOps = eligibleUsers.map((u) => ({
            updateOne: {
              filter: { _id: u._id },
              update: {
                $set: {
                  loanDidiStatus: 'FAILED',
                  loanDidiError: err.response?.data?.error?.message || err.message,
                  syncedAt: new Date()
                }
              }
            }
          }));

          if (failOps.length > 0) {
            await leadsCollection.bulkWrite(failOps);
          }

          console.log('⏳ Pausing 5s before next batch...');
          await sleep(5000);
        }
      }
    }

    console.log(`\n🎉 Goal Finished! Total ${totalSyncedToday} leads sent today (Skipped by pincode: ${totalSkippedPincode}).`);
  } catch (fatalErr) {
    console.error('💥 Fatal Worker Error:', fatalErr);
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB. Clean shutdown complete.');
    process.exit(0);
  }
}

startWorker();