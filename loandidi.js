require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const MONGO_URI = process.env.MONGO_URI_COVER || process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'coverloop';

const LEAD_COLLECTION = process.env.LEAD_COLLECTION || 'keshvadb';
const RESPONSE_COLLECTION = process.env.RESPONSE_COLLECTION || 'loandidd';

const LOANDIDI_API_KEY = process.env.LOANDIDI_API_KEY || 'ldk_live_NKYavhxhqt9Y9l6O0lLqfwHcMYjbnxlLMt2iyqMdPAU';
const BASE_URL = 'https://api.loandidi.com/api/method';

// 50 का बैच और 3.5s डिले (LoanDidi की 1000 leads/min लिमिट के अंदर एकदम सेफ)
const BATCH_SIZE = 10;
const DELAY_BETWEEN_BATCHES_MS = 3500;

// आज का टारगेट (CLI arg से या Env से, डिफ़ॉल्ट 1000)
const DAILY_LIMIT = parseInt(process.argv[2] || process.env.DAILY_LIMIT || '1000', 10);

// ==========================================
// 2. AXIOS CLIENT
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

// ==========================================
// 3. MAIN BATCH SYNC ENGINE
// ==========================================
async function startWorker() {
  console.log(`====================================================`);
  console.log(`🚀 LoanDidi Bulk Lead Sync Worker Initiated`);
  console.log(`🎯 Today's Quota: ${DAILY_LIMIT} leads`);
  console.log(`📦 Batch Size: ${BATCH_SIZE} leads/batch`);
  console.log(`📂 Database: ${DB_NAME} | Collection: ${LEAD_COLLECTION}`);
  console.log(`====================================================\n`);

  const client = new MongoClient(MONGO_URI);

  try {
    console.log('🔄 Connecting to MongoDB...');
    await client.connect();
    console.log('✅ Connected to MongoDB.\n');

    const db = client.db(DB_NAME);
    const leadsCollection = db.collection(LEAD_COLLECTION);
    const responseCollection = db.collection(RESPONSE_COLLECTION);

    // इंडेक्स बनाएं ताकि परफॉरमेंस फ़ास्ट रहे
    await leadsCollection.createIndex({ loanDidiStatus: 1, createdAt: 1 });

    let totalSyncedToday = 0;

    while (totalSyncedToday < DAILY_LIMIT) {
      const remainingQuota = DAILY_LIMIT - totalSyncedToday;
      const currentBatchLimit = Math.min(BATCH_SIZE, remainingQuota);

      // 1. DB से पेंडिंग यूज़र्स उठाएँ (जिनका स्टेटस PENDING, null या FAILED है)
      const users = await leadsCollection
        .find({ loanDidiStatus: { $in: [null, 'PENDING', 'FAILED'] } })
        .sort({ createdAt: 1 })
        .limit(currentBatchLimit)
        .toArray();

      if (!users || users.length === 0) {
        console.log('ℹ️ No more pending leads found in Database.');
        break;
      }

      console.log(`⏳ Processing batch of ${users.length} leads (Total Sent: ${totalSyncedToday}/${DAILY_LIMIT})...`);

      // 2. आपके डेटाबेस फ़ील्ड्स के हिसाब से LoanDidi पेलोड तैयार करें
      const leadsPayload = users.map((u) => ({
        partnerReference: `CM_${u._id}`,
        name: u.name,
        mobile: u.phone, // आपके डेटाबेस में 'phone' फ़ील्ड है[cite: 1]
        email: u.email || 'support@covermantra.in',
        pan: u.pan,
        dob: u.dob || '1995-01-01',
        monthly_income: Number(u.income) || 25000, // आपके डेटाबेस में 'income' फ़ील्ड है[cite: 1]
        loan_amount: u.loanAmount || 50000, // अगर डेटाबेस में नहीं है तो डिफ़ॉल्ट 50000
        pincode: String(u.pincode || '110001'),
        consent: true,
        consentChannel: 'website',
        consentText: 'I agree to share my details with LoanDidi for my loan application.'
      }));

      try {
        // 3. बल्क API कॉल (/partner.v1.leads.bulk)
        const response = await apiClient.post('/partner.v1.leads.bulk', {
          leads: leadsPayload
        });

        const results = response.data?.results || response.data?.leads || [];
        
        const bulkLeadOps = [];
        const responseLogs = [];

        users.forEach((user, idx) => {
          const res = results[idx] || null;
          const now = new Date();

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
              userId: user._id,
              leadId: res.lead,
              status: 'SUCCESS',
              response: res,
              createdAt: now
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
              userId: user._id,
              status: 'FAILED',
              error: errorMsg,
              response: res,
              createdAt: now
            });
          }
        });

        // 4. DB अपडेट करें
        if (bulkLeadOps.length > 0) {
          await leadsCollection.bulkWrite(bulkLeadOps);
        }

        if (responseLogs.length > 0) {
          await responseCollection.insertMany(responseLogs);
        }

        totalSyncedToday += users.length;
        console.log(`✅ Batch complete! Progress: ${totalSyncedToday}/${DAILY_LIMIT}`);

        if (totalSyncedToday >= DAILY_LIMIT) {
          break;
        }

        // 5. रेट लिमिटिंग डिले
        await sleep(DELAY_BETWEEN_BATCHES_MS);

      } catch (err) {
        const status = err.response?.status;
        const retryAfter = parseInt(err.response?.headers['retry-after'] || '10', 10);

        if (status === 429 || status === 503) {
          console.warn(`⚠️ Rate Limit / Server Busy (${status}). Backing off for ${retryAfter}s...`);
          await sleep(retryAfter * 1000);
        } else {
          console.error('❌ Batch API Failed:', err.response?.data || err.message);
          
          // अगर API फेल हो जाए तो इस बैच के रिकॉर्ड्स को FAILED मार्क करें
          const failOps = users.map((u) => ({
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

    console.log(`\n🎉 Goal Finished! Total ${totalSyncedToday} leads processed today.`);
  } catch (fatalErr) {
    console.error('💥 Fatal Worker Error:', fatalErr);
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB. Clean shutdown complete.');
    process.exit(0);
  }
}

startWorker();