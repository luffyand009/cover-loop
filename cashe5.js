const { MongoClient } = require("mongodb");
const axios = require("axios");
const path = require("path");
const XLSX = require("xlsx");
const crypto = require("crypto");
require("dotenv").config();

// --- CONFIGURATION ---
const MONGO_URI = process.env.MONGO_URI_COVER;

const DB_NAME = "coverloop";
const LEAD_COLLECTION = "payme3"; // Jaha se data uthega
const RESPONSE_COLLECTION = "cashe_responses3"; // Jaha response save hoga
const LENDER_NAME = "cashe";

// CASHe API URLs & Credentials
const BASE_URL = "https://partners.cashe.co.in";
const DUPLICATE_CHECK_URL = `${BASE_URL}/partner/checkDuplicateCustomerLead`;
const PRE_APPROVAL_URL = `${BASE_URL}/report/getLoanApprovalDetails`;
const CREATE_CUSTOMER_URL = `${BASE_URL}/partner/create_customer`;

const PARTNER_NAME = "Covermantra_API";
const SECRET_KEY = "wEz\\b2/gOp5R%tD8";

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

const BATCH_SIZE = 40;       // MongoDB se ek baar mein kitne records uthane hain
const CONCURRENCY_LIMIT = 4; // Ek sath kitni APIs parallel hit hongi (4 leads at a time)
const REQUEST_TIMEOUT = 30000;

let currentActiveRequests = 0; // Track karega ki kitni APIs exact time par chal rahi hain

function log(level, message) {
  console.log(`${new Date().toISOString()} [${level}] ${message}`);
}

function generateCheckSum(payload, secretKey = SECRET_KEY) {
  const dataStr = typeof payload === "string" ? payload : JSON.stringify(payload);
  return crypto.createHmac("sha1", secretKey).update(dataStr).digest("base64");
}

function getHeaders(payload) {
  const checkSum = generateCheckSum(payload);
  return {
    "Content-Type": "application/json",
    "Check-Sum": checkSum,
  };
}

function parseName(fullName = "") {
  const parts = String(fullName || "User Kumar").trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] || "User";
  const lastName = parts.slice(1).join(" ") || "Kumar";
  return { firstName, lastName };
}

function formatDOBCashe(dobStr) {
  if (!dobStr) return "1995-01-01 00:00:00";
  const date = new Date(dobStr);
  if (isNaN(date.getTime())) return "1995-01-01 00:00:00";
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} 00:00:00`;
}

function formatDOBCasheDDMMYYYY(dobStr) {
  if (!dobStr) return "14-02-1989";
  const date = new Date(dobStr);
  if (isNaN(date.getTime())) return "14-02-1989";
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const yyyy = date.getFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

function formatGenderShort(genderStr) {
  if (!genderStr) return "M";
  const cleanGender = String(genderStr).trim().toUpperCase();
  if (cleanGender.startsWith("F") || cleanGender.includes("FEMALE")) {
    return "F";
  }
  return "M";
}

function formatGenderCashe(genderStr) {
  if (!genderStr) return "M";
  const cleanGender = String(genderStr).trim().toUpperCase();
  if (cleanGender.startsWith("F") || cleanGender.includes("FEMALE")) {
    return "Female";
  }
  return "Male";
}

// 🛑 API hit hone se pehle validation check (Pincode & Required Fields)
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

// CASHe Multi-Step API Workflow Controller
async function processLead(item, leadCol, responseCol) {
  currentActiveRequests++;
  const mobile = item.phone || item.mobile || item.contact || "";
  log("INFO", `🟢 [START] Lead: ${mobile} | Current Active Requests: ${currentActiveRequests}`);

  const skipReason = shouldSkip(item);
  if (skipReason) {
    log("WARN", `Skipped lead ${mobile} due to: ${skipReason}`);
    if (item._id) {
      await leadCol.updateOne(
        { _id: item._id }, 
        { $addToSet: { processed: `${LENDER_NAME}: skipped_${skipReason}` } }
      );
    }
    currentActiveRequests--;
    log("INFO", `🔴 [END-SKIPPED] Lead: ${mobile} | Active Requests: ${currentActiveRequests}`);
    return false;
  }

  const email = item.email || "test@gmail.com";

  try {
    // 1. Check Duplicate Lead API
    const duplicatePayload = {
      partner_name: PARTNER_NAME,
      mobile_no: String(mobile),
      email_id: String(email),
    };

    const duplicateRes = await axios.post(DUPLICATE_CHECK_URL, duplicatePayload, {
      headers: getHeaders(duplicatePayload),
      timeout: REQUEST_TIMEOUT,
    });

    const duplicateData = duplicateRes.data || {};
    const canProceed = duplicateData?.duplicateStatusCode === 1;

    let casheResponseObj = { DuplicateCheck: duplicateData };

    if (!canProceed) {
      log("WARN", `Lead not eligible or duplicate status code for ${mobile}`);
      
      await responseCol.insertOne({
        phone: mobile,
        name: item.name || "",
        pan: item.pan || "",
        status: "NOT_ELIGIBLE_OR_DUPLICATE",
        api_response: casheResponseObj,
        createdAt: new Date().toISOString().slice(0, 10)
      });

      await leadCol.updateOne(
        { _id: item._id },
        { $addToSet: { processed: `${LENDER_NAME}: NOT_ELIGIBLE` } }
      );
      currentActiveRequests--;
      log("INFO", `🔴 [END-NOT_ELIGIBLE] Lead: ${mobile} | Active Requests: ${currentActiveRequests}`);
      return false;
    }

    // 2. Pre-Approval API
    const { firstName, lastName } = parseName(item.name);
    const preApprovalPayload = {
      partner_name: PARTNER_NAME,
      pan: String(item.pan || item.pancard || "ABCDE1234F").toUpperCase(),
      mobileNo: String(mobile),
      name: `${firstName} ${lastName}`,
      addressLine1: String(item.address || "Main Road"),
      locality: String(item.locality || "Sector 1"),
      pinCode: String(item.pincode || "125055"),
      gender: formatGenderShort(item.gender),
      salary: Number(item.income || item.salary || 35000),
      state: String(item.state || "HARYANA").toUpperCase(),
      city: String(item.city || "Fatehabad"),
      dob: formatDOBCashe(item.dob),
      employmentType: 1,
      salaryReceivedType: 3,
      emailId: String(email),
      companyName: String(item.companyName || "TechCorp"),
      loanAmount: Number(item.loanAmount || 50000),
    };

    const preApprovalRes = await axios.post(PRE_APPROVAL_URL, preApprovalPayload, {
      headers: getHeaders(preApprovalPayload),
      timeout: REQUEST_TIMEOUT,
    });

    const preApprovalData = preApprovalRes.data || {};
    casheResponseObj.PreApproval = preApprovalData;

    const approvalAmount = preApprovalData?.payLoad?.amount;
    const approvalStatus = preApprovalData?.payLoad?.status;

    const isAmountValid = approvalAmount !== null && approvalAmount !== undefined && approvalStatus !== "rejected";

    if (!isAmountValid) {
      log("WARN", `Pre-approval amount null or rejected for ${mobile}`);
      
      await responseCol.insertOne({
        phone: mobile,
        name: item.name || "",
        pan: item.pan || "",
        status: "PRE_APPROVAL_REJECTED",
        api_response: casheResponseObj,
        createdAt: new Date().toISOString().slice(0, 10)
      });

      await leadCol.updateOne(
        { _id: item._id },
        { $addToSet: { processed: `${LENDER_NAME}: PRE_APPROVAL_REJECTED` } }
      );
      currentActiveRequests--;
      log("INFO", `🔴 [END-REJECTED] Lead: ${mobile} | Active Requests: ${currentActiveRequests}`);
      return false;
    }

    // 3. Create Customer API
    const formattedDob = formatDOBCasheDDMMYYYY(item.dob);
    const loanAmt = String(approvalAmount || item.loanAmount || 50000);
    const userAadhaar = String(item.aadhaar || "[Aadhaar Redacted]");

    const createPayload = {
      partner_name: PARTNER_NAME,
      reference_Id: String(item._id || "123"),
      applicant_id: String(item.applicant_id || "234"),
      loan_amount: loanAmt,
      product_type_name: String(item.product_type_name || "CASHe_90"),
      "Personal Information": {
        "First Name": firstName,
        "Last Name": lastName,
        DOB: formattedDob,
        Gender: formatGenderCashe(item.gender),
        "Address Line 1": String(item.address || "Main Road"),
        "Address Line 2": String(item.addressLine2 || "Ambadi"),
        "Landmark (Address Line 3)": String(item.landmark || "Near HDFC"),
        Pincode: String(item.pincode || "125055"),
        City: String(item.city || "Fatehabad"),
        State: String(item.state || "HARYANA").toUpperCase(),
        "Type of Accommodation": String(item.accommodationType || "Own"),
        PAN: String(item.pan || "ABCDE1234F").toUpperCase(),
        Aadhaar: userAadhaar,
        "Highest Qualification": String(item.qualification || "Postgraduate"),
        residing_with: String(item.residingWith || "Family"),
        number_of_years_at_current_address: String(item.yearsAtAddress || "More than five years"),
        marital_status: String(item.maritalStatus || "Married"),
        spouse_employment_status: String(item.spouseEmployment || "Employed"),
        number_of_kids: String(item.kidsCount || "One"),
      },
      "Applicant Information": {
        "Company Name": String(item.companyName || "TechCorp"),
        "Office Phone no": String(item.officePhone || "04023456789"),
        Designation: String(item.designation || "Supervisor"),
        "Monthly Income": String(item.income || "35000"),
        "Number of Years in Current Work": String(item.yearsInWork || "5"),
        "Official Email": String(item.officialEmail || email),
        "Office Address 1": String(item.officeAddress1 || "Sakinaka"),
        "Office Address 2": String(item.officeAddress2 || "Andheri"),
        "Landmark (Office)": String(item.officeLandmark || "Near SBI"),
        "Office Pincode": String(item.officePincode || "410256"),
        "Office City": String(item.officeCity || "Adilabad"),
        "Office State": String(item.officeState || "TELANGANA"),
        "Working Since": String(item.workingSince || "29-07-2019"),
        "Employment Type": String(item.employmentType || "Salaried"),
        "Salary ReceivedTypeId": String(item.salaryReceivedTypeId || "1"),
        work_sector: String(item.workSector || "Information Technology"),
        job_function: String(item.jobFunction || "IT and Engineering"),
        organization: String(item.organization || "Private Company"),
      },
      "Financial Information": {
        "Primary Existing Bank Name": String(item.bankName || "HDFC Bank"),
        "Account number": String(item.accountNumber || "23982983239832"),
        "IFSC Code": String(item.ifscCode || "KKBK0000963"),
      },
      "Partner Bank Details": {
        "Primary Existing Bank Name": String(item.partnerBankName || "Axis Bank"),
        "Account number": String(item.partnerAccountNumber || "12324234234"),
        "IFSC Code": String(item.partnerIfscCode || "UTIB0000008"),
        Remarks: String(item.bankRemarks || "Anything about bank details"),
      },
      "Contact Information": {
        Mobile: mobile,
        "Email Id": email,
      },
      "e-KYC Customer": {
        poa: {
          co: String(item.poaCo || "S/O: Parent Name"),
          street: String(item.poaStreet || "Main Street"),
          house: String(item.poaHouse || "House 1"),
          lm: String(item.poaLm || "Near Park"),
          vtc: String(item.poaVtc || "City Center"),
          subdist: String(item.poaSubdist || "District Sub"),
          dist: String(item.city || "Fatehabad"),
          state: String(item.state || "HARYANA").toUpperCase(),
          pc: String(item.pincode || "125055"),
          po: String(item.poaPo || "Main Post Office"),
        },
        aadhar_no: userAadhaar,
        name: `${firstName} ${lastName}`,
        dob: formattedDob,
        gender: formatGenderShort(item.gender),
        "compressed-address": String(item.compressedAddress || `${item.address || ""}, ${item.city || ""}\n${item.pincode || ""}`),
      },
    };

    const createRes = await axios.post(CREATE_CUSTOMER_URL, createPayload, {
      headers: getHeaders(createPayload),
      timeout: REQUEST_TIMEOUT,
    });

    const createData = createRes.data || {};
    casheResponseObj.CreateCustomer = createData;

    await responseCol.insertOne({
      phone: mobile,
      name: item.name || "",
      pan: item.pan || "",
      status: "SUCCESS_PROCESSED",
      api_response: casheResponseObj,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    await leadCol.updateOne(
      { _id: item._id }, 
      { $addToSet: { processed: `${LENDER_NAME}: SUCCESS` } }
    );
    
    currentActiveRequests--;
    log("INFO", `🔴 [END-SUCCESS] Lead: ${mobile} | Active Requests: ${currentActiveRequests}`);
    return true;

  } catch (err) {
    const errData = err.response?.data || err.message;
    log("ERROR", `API Error for lead ${mobile}: ${JSON.stringify(errData)}`);

    await responseCol.insertOne({
      phone: mobile,
      name: item.name || "",
      pan: item.pan || "",
      status: "FAILED_ERROR",
      api_response: { error: errData },
      createdAt: new Date().toISOString().slice(0, 10)
    });

    await leadCol.updateOne(
      { _id: item._id }, 
      { $addToSet: { processed: `${LENDER_NAME}: ERROR` } }
    );
    currentActiveRequests--;
    log("INFO", `🔴 [END-ERROR] Lead: ${mobile} | Active Requests: ${currentActiveRequests}`);
    return false;
  }
}

// Helper: Array ko chhote chunks mein todne ke liye
function chunkArray(array, size) {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Helper: Chunks ko parallel (4-4 ke group mein) chalane ke liye
async function processBatchConcurrently(batchLeads, leadCol, responseCol, concurrencyLimit) {
  const chunks = chunkArray(batchLeads, concurrencyLimit);
  let processedCount = 0;

  for (const chunk of chunks) {
    const results = await Promise.all(
      chunk.map(async (item) => {
        return await processLead(item, leadCol, responseCol);
      })
    );

    results.forEach(success => {
      if (success) processedCount++;
    });

    await new Promise(r => setTimeout(r, 100));
  }

  return processedCount;
}

async function main() {
  if (!MONGO_URI) {
    log("ERROR", "❌ MONGO_URI_COVER is not defined in the environment variables (.env).");
    return;
  }

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
    let total = 0, processed = 0;
    let batch = [];

    for await (const lead of cursor) {
      total++;
      batch.push(lead);

      if (batch.length === BATCH_SIZE) {
        log("INFO", `🚀 Processing batch of ${batch.length} leads with concurrency limit ${CONCURRENCY_LIMIT}...`);
        const count = await processBatchConcurrently(batch, leadCol, responseCol, CONCURRENCY_LIMIT);
        processed += count;
        batch = [];
      }
    }

    if (batch.length > 0) {
      log("INFO", `🚀 Processing final batch of ${batch.length} leads...`);
      const count = await processBatchConcurrently(batch, leadCol, responseCol, CONCURRENCY_LIMIT);
      processed += count;
    }

    log("INFO", `----- SUMMARY -----\nTOTAL FETCHED: ${total}\nPROCESSED: ${processed}`);
    await client.close();
  } catch (err) {
    log("ERROR", `Fatal error: ${err.message}`);
    if (client) await client.close();
  }
}

main();