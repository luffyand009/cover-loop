require('dotenv').config();
const { MongoClient } = require('mongodb');
const axios = require('axios');
const path = require('path');
const XLSX = require('xlsx');

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const MONGO_URI =
  process.env.MONGO_URI_COVER ||
  process.env.MONGO_URI ||
  'mongodb://localhost:27017';
const DB_NAME = process.env.DB_NAME || 'coverloop';
const LEAD_COLLECTION = process.env.LEAD_COLLECTION || 'keshvadb';
const RESPONSE_COLLECTION =
  process.env.MONEYBRO_RESPONSE_COLLECTION || 'moneybro_responses';

// Excel / XLS Pincode File Config
const PINCODE_EXCEL_PATH =
  process.env.PINCODE_EXCEL_PATH || path.join(__dirname, 'moneybro.xlsx');
const PINCODE_SHEET_NAME = process.env.PINCODE_SHEET_NAME || '';
const PINCODE_COLUMN_NAME = process.env.PINCODE_COLUMN_NAME || 'pincode';

// Fallback Pincode List (agar Excel file na ho ya khali ho)
const ALLOWED_PINCODES = [
  // '110001',
  // '831004',
];

// Eligibility Filters
const MIN_INCOME = Number(process.env.MIN_INCOME || 20000);
const MIN_AGE = Number(process.env.MIN_AGE || 21);
const MAX_AGE = Number(process.env.MAX_AGE || 55);

const CONFIG = {
  baseUrl: process.env.MONEYBRO_BASE_URL || 'https://web.moneybro.in/cloudbankin/api/v1',
  tenantId: process.env.MONEYBRO_TENANT_ID || 'default',
  username: process.env.MONEYBRO_USERNAME || 'CoverMantra',
  password: process.env.MONEYBRO_PASSWORD || 'o]34oA:xU@a@Pv42',
  formName: process.env.MONEYBRO_FORM_NAME || 'JMJ Short Term Loan (Single Repayment) - New',

  entityId: Number(process.env.MONEYBRO_ENTITY_ID || 151),
  officeId: Number(process.env.MONEYBRO_OFFICE_ID || 1),
  leadSourceId: Number(process.env.MONEYBRO_LEAD_SOURCE_ID || 569035),
  referralCode: process.env.MONEYBRO_REFERRAL_CODE || 'Covermantra_50',
  utmOnboardingUrl:
    process.env.MONEYBRO_ONBOARDING_URL ||
    'https://web.moneybro.in/onboard/?referral_code=Covermantra_50#/login/borrower',

  batchSize: Number(process.env.BATCH_SIZE || 50),
  delayMs: Number(process.env.DELAY_MS || 15000),
  idleWaitMs: Number(process.env.IDLE_WAIT_MS || 60000),
  dailyLimit: parseInt(process.argv[2] || process.env.DAILY_LIMIT || '1000', 10),
};

// ==========================================
// 2. CLIENT & AUTH STATE
// ==========================================
let authToken = null;
let cachedFormMeta = null;
let isShuttingDown = false;
let allowedPincodeSet = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const apiClient = axios.create({
  baseURL: CONFIG.baseUrl,
  headers: {
    'Content-Type': 'application/json',
    'cloudbankin-tenantid': CONFIG.tenantId,
  },
  timeout: 30000,
});

function loadPincodesFromExcel() {
  const pincodes = new Set();

  try {
    const workbook = XLSX.readFile(PINCODE_EXCEL_PATH);
    const sheetName = PINCODE_SHEET_NAME || workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];

    if (sheet) {
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      const targetColLower = PINCODE_COLUMN_NAME.trim().toLowerCase();

      for (const row of rows) {
        let rawPin = '';

        // Exact or case-insensitive column match
        for (const [key, val] of Object.entries(row)) {
          if (String(key).trim().toLowerCase() === targetColLower) {
            rawPin = val;
            break;
          }
        }

        // Agar column name match na ho to pehli column ki value le lo
        if (!rawPin) {
          const firstVal = Object.values(row)[0];
          rawPin = firstVal;
        }

        const cleaned = String(rawPin || '').replace(/\D/g, '').trim();
        if (/^\d{6}$/.test(cleaned)) {
          pincodes.add(cleaned);
        }
      }
    }

    if (pincodes.size > 0) {
      console.log(`📍 Loaded ${pincodes.size} pincodes from Excel: ${PINCODE_EXCEL_PATH}`);
      return pincodes;
    }
  } catch (err) {
    console.warn(`⚠️ Could not read Excel pincodes (${PINCODE_EXCEL_PATH}): ${err.message}`);
  }

  for (const p of ALLOWED_PINCODES) {
    const cleaned = String(p).replace(/\D/g, '').trim();
    if (/^\d{6}$/.test(cleaned)) {
      pincodes.add(cleaned);
    }
  }

  if (pincodes.size > 0) {
    console.log(`📍 Using ${pincodes.size} fallback pincodes from ALLOWED_PINCODES.`);
  } else {
    console.log('📍 No pincode filter active (ALL pincodes allowed).');
  }

  return pincodes;
}

function parseDobDate(dobStr) {
  if (!dobStr) return null;
  const clean = String(dobStr).trim();

  let match = clean.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (match) {
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }

  match = clean.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (match) {
    return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  }

  const parsed = new Date(clean);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(dobStr) {
  const dt = parseDobDate(dobStr);
  if (!dt) return '1995-01-01';
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function calculateAge(dobStr, refDate = new Date()) {
  const dob = parseDobDate(dobStr);
  if (!dob) return null;

  let age = refDate.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = refDate.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && refDate.getUTCDate() < dob.getUTCDate())) {
    age--;
  }
  return age;
}

function isLeadEligible(doc) {
  const emp = String(doc.employment || '').trim().toLowerCase();
  if (emp !== 'salaried') return false;

  const numericIncome = Number(String(doc.income ?? '').replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(numericIncome) || numericIncome < MIN_INCOME) return false;

  const age = calculateAge(doc.dob);
  if (age === null || age < MIN_AGE || age > MAX_AGE) return false;

  if (allowedPincodeSet.size > 0) {
    const pin = String(doc.pincode || '').replace(/\D/g, '').trim();
    if (!allowedPincodeSet.has(pin)) return false;
  }

  return true;
}

function buildPendingQuery() {
  const conditions = [
    {
      $or: [
        { moneybroStatus: { $exists: false } },
        { moneybroStatus: null },
        { moneybroStatus: 'PENDING' },
      ],
    },
    {
      employment: { $regex: /^salaried$/i },
    },
    {
      $expr: {
        $gte: [
          {
            $convert: {
              input: {
                $replaceAll: {
                  input: { $toString: { $ifNull: ['$income', '0'] } },
                  find: ',',
                  replacement: '',
                },
              },
              to: 'double',
              onError: 0,
              onNull: 0,
            },
          },
          MIN_INCOME,
        ],
      },
    },
  ];

  if (allowedPincodeSet.size > 0) {
    conditions.push({
      pincode: { $in: Array.from(allowedPincodeSet) },
    });
  }

  return { $and: conditions };
}

async function login() {
  const res = await apiClient.post('/authentication/login', {
    username: CONFIG.username,
    password: CONFIG.password,
    recaptcha_token: '',
  });

  const data = res.data || {};
  if (!data.authenticated || !data.base64EncodedAuthenticationKey) {
    throw new Error(`Authentication rejected: ${JSON.stringify(data)}`);
  }

  authToken = data.base64EncodedAuthenticationKey;
  apiClient.defaults.headers.common.Authorization = `Basic ${authToken}`;
  console.log(`[AUTH] Logged in (userId: ${data.userId}, staffId: ${data.staffId})`);
  return authToken;
}

async function apiRequest(config, retry = true) {
  if (!authToken) await login();

  try {
    return await apiClient.request(config);
  } catch (err) {
    if (err.response?.status === 401 && retry) {
      console.warn('[AUTH] Token expired (401). Re-logging in...');
      await login();
      return apiRequest(config, false);
    }
    throw err;
  }
}

async function getFormMetadata() {
  if (cachedFormMeta) return cachedFormMeta;

  const res = await apiRequest({
    method: 'GET',
    url: '/entityprefill/datamodel/prepopulate/template',
    params: { type: 'form', name: CONFIG.formName },
  });

  const tpl = res.data || {};
  if (!tpl.id || !Array.isArray(tpl.fieldsTemplateDataList)) {
    throw new Error(`Invalid template response for "${CONFIG.formName}"`);
  }

  const fieldMap = {};
  const dropdownLookup = {};

  for (const field of tpl.fieldsTemplateDataList) {
    const groupKey = `${field.groupDisplayName}::${field.columnName}`.toLowerCase();
    fieldMap[groupKey] = field.id;
    fieldMap[field.columnName.toLowerCase()] = field.id;

    if (field.type === 'dropdown' && Array.isArray(field.columnValues)) {
      dropdownLookup[field.id] = field.columnValues;
    }
  }

  cachedFormMeta = { formId: tpl.id, fieldMap, dropdownLookup };
  console.log(`[TEMPLATE] Loaded "${tpl.name}" (sourceId: ${tpl.id})`);
  return cachedFormMeta;
}

// ==========================================
// 3. DEDUPE & SAVE LEAD
// ==========================================
async function checkDedupe(mobile, email, pan) {
  const res = await apiRequest({
    method: 'POST',
    url: '/los/dedupe/lead',
    data: {
      mobileNumber: mobile,
      email,
      identifiers: pan ? [{ identifierType: 17, identifierValue: pan }] : [],
    },
  });
  return res.data;
}

function resolveDropdownId(dropdownLookup, fieldId, rawValue, parentRefId = null) {
  const options = dropdownLookup[fieldId] || [];
  if (!rawValue || !fieldId) return null;

  const target = String(rawValue).trim().toLowerCase();
  const match = options.find((opt) => {
    const valMatch = String(opt.value).trim().toLowerCase() === target;
    return parentRefId ? valMatch && opt.referenceId === parentRefId : valMatch;
  });

  return match ? String(match.id) : null;
}

async function saveLead(lead, includeReferralCode = true) {
  const { formId, fieldMap, dropdownLookup } = await getFormMetadata();

  const rawName = String(lead.firstName || lead.name || '').trim();
  const nameParts = rawName.split(/\s+/).filter(Boolean);
  const firstName = nameParts[0] || '';
  const lastName =
    String(lead.last_name || lead.lastName || '').trim() ||
    nameParts.slice(1).join(' ') ||
    'Kumar';

  const mobile = String(lead.mobile || lead.phone || '').replace(/\D/g, '').slice(-10);
  const pan = String(lead.pan || '').trim().toUpperCase();
  const email = String(lead.email || 'support@covermantra.in').trim().toLowerCase();

  if (mobile.length !== 10 || !firstName || !email.includes('@')) {
    throw new Error(`Validation failed: mobile (${mobile}), name (${firstName}), or email (${email})`);
  }

  const fields = [];
  const pushField = (id, val) => {
    if (id && val !== undefined && val !== null && String(val).trim() !== '') {
      fields.push({ id, value: String(val).trim() });
    }
  };

  if (/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
    pushField(fieldMap['enter your pan number'], pan);
  }
  pushField(fieldMap['first name'], firstName);
  pushField(fieldMap['last name'], lastName);
  pushField(fieldMap['phone number'], mobile);
  pushField(fieldMap['email address'], email);
  pushField(fieldMap['date of birth'], formatDate(lead.dob));
  pushField(fieldMap['permanent address::address line 1'], lead.address);
  pushField(fieldMap['permanent address::city'], lead.city);
  pushField(fieldMap['monthly income'], lead.income);
  pushField(fieldMap['employment type'], lead.employment);
  pushField(fieldMap['gender'], lead.gender);

  const stateFieldId = fieldMap['customer details::state'];
  const districtFieldId = fieldMap['customer details::district'];
  const pincodeFieldId = fieldMap['customer details::pincode'];

  const stateId = resolveDropdownId(dropdownLookup, stateFieldId, lead.state);
  const districtId = resolveDropdownId(
    dropdownLookup,
    districtFieldId,
    lead.district || lead.city,
    stateId ? Number(stateId) : null
  );
  const pincodeId = resolveDropdownId(
    dropdownLookup,
    pincodeFieldId,
    lead.pincode,
    districtId ? Number(districtId) : null
  );

  pushField(stateFieldId, stateId);
  pushField(districtFieldId, districtId);
  pushField(pincodeFieldId, pincodeId);

  const payload = {
    sourceId: formId,
    sourceType: 200,
    entityType: 600,
    entityId: CONFIG.entityId,
    officeId: CONFIG.officeId,
    leadSourceId: CONFIG.leadSourceId,
    referenceId: mobile,
    ...(includeReferralCode && CONFIG.referralCode ? { referralCode: CONFIG.referralCode } : {}),
    fields,
  };

  try {
    const res = await apiRequest({
      method: 'POST',
      url: '/entityprefill/datamodel/prepopulate',
      data: payload,
    });
    return {
      recordId: Number(res.data),
      rawResponse: res.data,
      payload,
    };
  } catch (err) {
    const status = err.response?.status;
    const errData = err.response?.data;
    const errMsg = typeof errData === 'string' ? errData : JSON.stringify(errData || err.message);

    if (status === 400 && errMsg.includes('Invalid referral code') && includeReferralCode) {
      console.warn(`[SAVE] Retrying ${mobile} without referralCode...`);
      return saveLead(lead, false);
    }

    const saveError = new Error(`Save failed (${status || 'ERR'}): ${errMsg}`);
    saveError.apiResponse = errData || err.message;
    throw saveError;
  }
}

// ==========================================
// 4. MAIN WORKER LOOP
// ==========================================
async function startWorker() {
  allowedPincodeSet = loadPincodesFromExcel();

  console.log('====================================================');
  console.log('🚀 MoneyBro Lead Sync Worker Initiated');
  console.log(`🎯 Today's Quota: ${CONFIG.dailyLimit} leads`);
  console.log(`💼 Filter: Salaried | Income >= ${MIN_INCOME} | Age ${MIN_AGE}-${MAX_AGE}`);
  console.log(`📄 Pincode File: ${PINCODE_EXCEL_PATH} (${allowedPincodeSet.size} active pincodes)`);
  console.log(`📂 Database: ${DB_NAME} | Leads: ${LEAD_COLLECTION} | Logs: ${RESPONSE_COLLECTION}`);
  console.log('====================================================\n');

  const client = new MongoClient(MONGO_URI);
  let totalProcessedToday = 0;

  try {
    await client.connect();
    console.log('✅ Connected to MongoDB.\n');

    const db = client.db(DB_NAME);
    const leadsCollection = db.collection(LEAD_COLLECTION);
    const responseCollection = db.collection(RESPONSE_COLLECTION);

    await leadsCollection.createIndex({ moneybroStatus: 1, createdAt: 1 });
    await responseCollection.createIndex({ userId: 1, createdAt: -1 });

    await login();
    await getFormMetadata();

    const query = buildPendingQuery();

    while (!isShuttingDown && totalProcessedToday < CONFIG.dailyLimit) {
      const remaining = CONFIG.dailyLimit - totalProcessedToday;
      const fetchLimit = Math.min(CONFIG.batchSize * 2, remaining * 2);

      const candidateLeads = await leadsCollection
        .find(query)
        .sort({ createdAt: 1 })
        .limit(fetchLimit)
        .toArray();

      const pendingLeads = candidateLeads.filter(isLeadEligible).slice(0, remaining);

      if (!pendingLeads || pendingLeads.length === 0) {
        console.log(
          `[LOOP] Koi eligible pending lead nahi bachi (Salaried, Income >= ${MIN_INCOME}, Age ${MIN_AGE}-${MAX_AGE}). ${CONFIG.idleWaitMs / 1000}s baad check karega...`
        );
        await sleep(CONFIG.idleWaitMs);
        continue;
      }

      for (let i = 0; i < pendingLeads.length; i++) {
        if (isShuttingDown || totalProcessedToday >= CONFIG.dailyLimit) break;

        const doc = pendingLeads[i];
        const mobile = String(doc.mobile || doc.phone || '').replace(/\D/g, '').slice(-10);
        const email = String(doc.email || 'support@covermantra.in').trim().toLowerCase();
        const pan = String(doc.pan || '').trim().toUpperCase();

        try {
          const dedupe = await checkDedupe(mobile, email, pan);
          const now = new Date();

          if (dedupe?.matched) {
            const errorMsg = `Dedupe matched: ${JSON.stringify(dedupe.matches)}`;

            await leadsCollection.updateOne(
              { _id: doc._id },
              {
                $set: {
                  moneybroStatus: 'DUPLICATE',
                  moneybroError: errorMsg,
                  moneybroSyncedAt: now,
                },
              }
            );

            await responseCollection.insertOne({
              userId: doc._id,
              mobile,
              pan,
              status: 'DUPLICATE',
              error: errorMsg,
              response: dedupe,
              createdAt: now,
            });

            totalProcessedToday++;
            console.log(`[${i + 1}/${pendingLeads.length}] DUPLICATE: ${mobile}`);
            continue;
          }

          const { recordId, rawResponse, payload } = await saveLead(doc, true);
          const syncedAt = new Date();

          await leadsCollection.updateOne(
            { _id: doc._id },
            {
              $set: {
                moneybroStatus: 'PUSHED',
                moneybroRecordId: recordId,
                moneybroOnboardingUrl: CONFIG.utmOnboardingUrl,
                moneybroError: null,
                moneybroSyncedAt: syncedAt,
              },
            }
          );

          await responseCollection.insertOne({
            userId: doc._id,
            mobile,
            pan,
            recordId,
            onboardingUrl: CONFIG.utmOnboardingUrl,
            status: 'SUCCESS',
            requestPayload: payload,
            response: rawResponse,
            createdAt: syncedAt,
          });

          totalProcessedToday++;
          console.log(`[${i + 1}/${pendingLeads.length}] PUSHED: ${mobile} -> Record ID: ${recordId}`);

          if (!isShuttingDown && totalProcessedToday < CONFIG.dailyLimit) {
            await sleep(CONFIG.delayMs);
          }
        } catch (err) {
          const status = err.response?.status;
          if (status === 429 || status === 503) {
            const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '10', 10);
            console.warn(`⚠️ Rate Limit / Server Busy (${status}). Backing off for ${retryAfter}s...`);
            await sleep(retryAfter * 1000);
            i--;
            continue;
          }

          const isDuplicate = String(err.message || '').toLowerCase().includes('already exists');
          const failStatus = isDuplicate ? 'DUPLICATE' : 'FAILED';
          const failedAt = new Date();

          await leadsCollection.updateOne(
            { _id: doc._id },
            {
              $set: {
                moneybroStatus: failStatus,
                moneybroError: err.message,
                moneybroSyncedAt: failedAt,
              },
            }
          );

          await responseCollection.insertOne({
            userId: doc._id,
            mobile,
            pan,
            status: failStatus,
            error: err.message,
            response: err.apiResponse || err.response?.data || null,
            createdAt: failedAt,
          });

          totalProcessedToday++;
          console.error(
            `[${i + 1}/${pendingLeads.length}] ${failStatus} (${mobile}): ${err.message}`
          );
        }
      }
    }

    console.log(`\n🎉 Finished! Total ${totalProcessedToday} leads processed.`);
  } catch (err) {
    console.error('💥 Fatal Worker Error:', err);
    process.exitCode = 1;
  } finally {
    await client.close();
    console.log('🔌 Disconnected from MongoDB.');
    process.exit(process.exitCode || 0);
  }
}

process.on('SIGINT', () => {
  isShuttingDown = true;
});

process.on('SIGTERM', () => {
  isShuttingDown = true;
});

startWorker();