require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
// FIX: MongoDB URI को कोट्स (' ') के अंदर कर दिया गया है ताकि Syntax Error न आए
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://CoverVishu:NXyVviJaZ6l0uSNv@cluster0.owcxx3v.mongodb.net/';
const LOANDIDI_API_KEY = process.env.LOANDIDI_API_KEY || 'ldk_test_IFPFZ0VF8Bg5X15SsAC82dsB32HXkJBc6_2y1J3SKKs';
const BASE_URL = 'https://api.loandidi.com/api/method';

// 50 का बैच और 3.5s डिले (LoanDidi की 1000 leads/min लिमिट के अंदर एकदम सेफ)
const BATCH_SIZE = 50;
const DELAY_BETWEEN_BATCHES_MS = 3500;

// आज का टारगेट (CLI arg से या Env से, डिफ़ॉल्ट 1000)
const DAILY_LIMIT = parseInt(process.argv[2] || process.env.DAILY_LIMIT || '1000', 10);

// ==========================================
// 2. MONGOOSE SCHEMA & MODEL
// ==========================================
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  mobile: { type: String, required: true },
  email: String,
  pan: String,
  dob: String,
  monthlyIncome: Number,
  loanAmount: Number,
  pincode: String,
  
  // LoanDidi Tracking Fields
  loanDidiStatus: { 
    type: String, 
    default: 'PENDING', 
    enum: ['PENDING', 'PROCESSING', 'SUBMITTED', 'FAILED', 'REJECTED', 'DISBURSED'] 
  },
  loanDidiLeadId: String,
  loanDidiApplyLink: String,
  partnerReference: String,
  loanDidiError: String,
  syncedAt: Date
}, { timestamps: true });

// इंडेक्स ताकि लाख यूज़र्स में भी 50 रिकॉर्ड्स तुरंत उठें
userSchema.index({ loanDidiStatus: 1, createdAt: 1 });

const User = mongoose.model('User', userSchema);

// ==========================================
// 3. AXIOS CLIENT
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
// 4. DB OPERATIONS
// ==========================================
async function fetchBatch(limit) {
  return await User.find({ loanDidiStatus: 'PENDING' })
    .select('_id name mobile email pan dob monthlyIncome loanAmount pincode')
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
}

async function updateDbBatch(users, results, fallbackError = null) {
  const bulkOps = users.map((user, idx) => {
    const res = results ? results[idx] : null;

    if (res && res.lead) {
      return {
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: {
              loanDidiStatus: 'SUBMITTED',
              loanDidiLeadId: res.lead,
              loanDidiApplyLink: res.applyLink || '',
              partnerReference: `CM_${user._id}`,
              syncedAt: new Date()
            }
          }
        }
      };
    } else {
      return {
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: {
              loanDidiStatus: 'FAILED',
              loanDidiError: fallbackError || (res?.error?.message || 'Submission failed'),
              syncedAt: new Date()
            }
          }
        }
      };
    }
  });

  if (bulkOps.length > 0) {
    await User.bulkWrite(bulkOps);
  }
}

// ==========================================
// 5. MAIN BATCH SYNC ENGINE
// ==========================================
async function startWorker() {
  console.log(`====================================================`);
  console.log(`🚀 LoanDidi Bulk Lead Sync Worker Initiated`);
  console.log(`🎯 Today's Quota: ${DAILY_LIMIT} leads`);
  console.log(`📦 Batch Size: ${BATCH_SIZE} leads/batch`);
  console.log(`====================================================\n`);

  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(MONGO_URI);
    console.log('✅ Connected to MongoDB.\n');

    let totalSyncedToday = 0;

    while (totalSyncedToday < DAILY_LIMIT) {
      const remainingQuota = DAILY_LIMIT - totalSyncedToday;
      const currentBatchLimit = Math.min(BATCH_SIZE, remainingQuota);

      // 1. DB से पेंडिंग यूज़र्स उठाएँ
      const users = await fetchBatch(currentBatchLimit);

      if (!users || users.length === 0) {
        console.log('ℹ️ No more pending leads found in Database.');
        break;
      }

      console.log(`⏳ Processing batch of ${users.length} leads (Total Sent: ${totalSyncedToday}/${DAILY_LIMIT})...`);

      // 2. LoanDidi OAS 3.1 के हिसाब से पेलोड तैयार करें
      const leadsPayload = users.map((u) => ({
        partnerReference: `CM_${u._id}`,
        name: u.name,
        mobile: u.mobile,
        email: u.email || 'support@covermantra.in',
        pan: u.pan,
        dob: u.dob || '1995-01-01',
        monthly_income: u.monthlyIncome || 25000,
        loan_amount: u.loanAmount || 50000,
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

        // 4. DB अपडेट करें
        const results = response.data?.results || response.data?.leads || [];
        await updateDbBatch(users, results);

        totalSyncedToday += users.length;
        console.log(`✨ Batch complete! Progress: ${totalSyncedToday}/${DAILY_LIMIT}`);

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
          // इस बैच को DB में FAILED मार्क करें ताकि लूप इसी पर न अटका रहे
          await updateDbBatch(users, null, err.response?.data?.error?.message || err.message);
          console.log('⏳ Pausing 5s before next batch...');
          await sleep(5000);
        }
      }
    }

    console.log(`\n🎉 Goal Finished! Total ${totalSyncedToday} leads sent to LoanDidi today.`);
  } catch (fatalErr) {
    console.error('💥 Fatal Worker Error:', fatalErr);
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB. Clean shutdown complete.');
    process.exit(0);
  }
}

startWorker();