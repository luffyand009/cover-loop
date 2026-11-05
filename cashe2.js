require("dotenv").config();
const mongoose = require("mongoose");
const axios = require("axios");
const crypto = require("crypto");

// --- CONFIGURATION ---
const BASE_URL = "https://partners.cashe.co.in";
const DUPLICATE_CHECK_URL = `${BASE_URL}/partner/checkDuplicateCustomerLead`;
const PRE_APPROVAL_URL = `${BASE_URL}/report/getLoanApprovalDetails`;
const CREATE_CUSTOMER_URL = `${BASE_URL}/partner/create_customer`;

const PARTNER_NAME = "Covermantra_API";
const SECRET_KEY = "wEz\\b2/gOp5R%tD8";

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://blackcloverasta792_db_user:mxJzuVmRTxrQyE46@cluster0.dsn4lqn.mongodb.net/personal?retryWrites=true&w=majority";

// --- PERFORMANCE & SAFETY SETTINGS ---
const NUM_WORKERS = 4; // Total 4 parallel loops/workers
const BATCH_SIZE = 1;  // Per worker batch size
const DELAY_MS = 3000; // Increased delay to prevent API rate limiting

let globalSuccessCount = 0;
let globalTotalLeads = 0;

const UserDB = mongoose.model(
  "cover_cash",
  new mongoose.Schema({}, { collection: "cover_cash", strict: false })
);

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

function formatGenderCashe(genderStr) {
  if (!genderStr) return "M";
  const cleanGender = String(genderStr).trim().toUpperCase();
  if (cleanGender.startsWith("F") || cleanGender.includes("FEMALE")) {
    return "Female";
  }
  return "Male";
}

function formatGenderShort(genderStr) {
  if (!genderStr) return "M";
  const cleanGender = String(genderStr).trim().toUpperCase();
  if (cleanGender.startsWith("F") || cleanGender.includes("FEMALE")) {
    return "F";
  }
  return "M";
}

function generateValidAadhaar() {
  const firstDigit = Math.floor(Math.random() * 8) + 2;
  let remainingDigits = "";
  for (let i = 0; i < 11; i++) {
    remainingDigits += Math.floor(Math.random() * 10);
  }
  return `${firstDigit}${remainingDigits}`;
}

// 1. Check Duplicate Customer Lead API
async function checkDuplicateLead(mobile, email) {
  try {
    const payload = {
      partner_name: PARTNER_NAME,
      mobile_no: String(mobile || ""),
      email_id: String(email || "test@gmail.com"),
    };

    const response = await axios.post(DUPLICATE_CHECK_URL, payload, {
      headers: getHeaders(payload),
    });
    return response.data;
  } catch (error) {
    const errData = error.response?.data || error.message;
    return {
      status: "ERROR",
      message: error.message,
      errorData: errData,
    };
  }
}

// 2. Pre-Approval API
async function getPreApproval(user) {
  try {
    const mobile = user.phone || user.mobile || user.contact || "";
    const { firstName, lastName } = parseName(user.name);
    const payload = {
      partner_name: PARTNER_NAME,
      pan: String(user.pan || user.pancard || "ABCDE1234F").toUpperCase(),
      mobileNo: String(mobile),
      name: `${firstName} ${lastName}`,
      addressLine1: String(user.address || "Main Road"),
      locality: String(user.locality || "Sector 1"),
      pinCode: String(user.pincode || "125055"),
      gender: formatGenderShort(user.gender),
      salary: Number(user.income || user.salary || 35000),
      state: String(user.state || "HARYANA").toUpperCase(),
      city: String(user.city || "Fatehabad"),
      dob: formatDOBCashe(user.dob),
      employmentType: 1,
      salaryReceivedType: 3,
      emailId: String(user.email || "test@gmail.com"),
      companyName: String(user.companyName || "TechCorp"),
      loanAmount: Number(user.loanAmount || 50000),
    };

    const response = await axios.post(PRE_APPROVAL_URL, payload, {
      headers: getHeaders(payload),
    });
    return response.data;
  } catch (error) {
    const errData = error.response?.data || error.message;
    return {
      status: "ERROR",
      message: error.message,
      errorData: errData,
    };
  }
}

// 3. Create Customer API
async function createCustomer(user, preApprovalAmount) {
  try {
    const { firstName, lastName } = parseName(user.name);
    const formattedDob = formatDOBCasheDDMMYYYY(user.dob);
    const mobileNo = String(user.phone || user.mobile || user.contact || "");
    const emailId = String(user.email || "test@gmail.com");
    const panNo = String(user.pan || user.pancard || "ABCDE1234F").toUpperCase();
    const pinCode = String(user.pincode || "125055");
    const city = String(user.city || "Fatehabad");
    const state = String(user.state || "HARYANA").toUpperCase();
    const address = String(user.address || "Main Road");
    const company = String(user.companyName || "TechCorp");
    const monthlyIncome = String(user.income || user.salary || 35000);
    const loanAmt = String(preApprovalAmount || user.loanAmount || 50000);
    const userAadhaar = String(user.aadhaar || generateValidAadhaar());

    const payload = {
      partner_name: PARTNER_NAME,
      reference_Id: String(user._id || "123"),
      applicant_id: String(user.applicant_id || "234"),
      loan_amount: loanAmt,
      product_type_name: String(user.product_type_name || "CASHe_90"),
      "Personal Information": {
        "First Name": firstName,
        "Last Name": lastName,
        DOB: formattedDob,
        Gender: formatGenderCashe(user.gender),
        "Address Line 1": address,
        "Address Line 2": String(user.addressLine2 || "Ambadi"),
        "Landmark (Address Line 3)": String(user.landmark || "Near HDFC"),
        Pincode: pinCode,
        City: city,
        State: state,
        "Type of Accommodation": String(user.accommodationType || "Own"),
        PAN: panNo,
        Aadhaar: userAadhaar,
        "Highest Qualification": String(user.qualification || "Postgraduate"),
        residing_with: String(user.residingWith || "Family"),
        number_of_years_at_current_address: String(user.yearsAtAddress || "More than five years"),
        marital_status: String(user.maritalStatus || "Married"),
        spouse_employment_status: String(user.spouseEmployment || "Employed"),
        number_of_kids: String(user.kidsCount || "One"),
      },
      "Applicant Information": {
        "Company Name": company,
        "Office Phone no": String(user.officePhone || "04023456789"),
        Designation: String(user.designation || "Supervisor"),
        "Monthly Income": monthlyIncome,
        "Number of Years in Current Work": String(user.yearsInWork || "5"),
        "Official Email": String(user.officialEmail || emailId),
        "Office Address 1": String(user.officeAddress1 || "Sakinaka"),
        "Office Address 2": String(user.officeAddress2 || "Andheri"),
        "Landmark (Office)": String(user.officeLandmark || "Near SBI"),
        "Office Pincode": String(user.officePincode || "410256"),
        "Office City": String(user.officeCity || "Adilabad"),
        "Office State": String(user.officeState || "TELANGANA"),
        "Working Since": String(user.workingSince || "29-07-2019"),
        "Employment Type": String(user.employmentType || "Salaried"),
        "Salary ReceivedTypeId": String(user.salaryReceivedTypeId || "1"),
        work_sector: String(user.workSector || "Information Technology"),
        job_function: String(user.jobFunction || "IT and Engineering"),
        organization: String(user.organization || "Private Company"),
      },
      "Financial Information": {
        "Primary Existing Bank Name": String(user.bankName || "HDFC Bank"),
        "Account number": String(user.accountNumber || "23982983239832"),
        "IFSC Code": String(user.ifscCode || "KKBK0000963"),
      },
      "Partner Bank Details": {
        "Primary Existing Bank Name": String(user.partnerBankName || "Axis Bank"),
        "Account number": String(user.partnerAccountNumber || "12324234234"),
        "IFSC Code": String(user.partnerIfscCode || "UTIB0000008"),
        Remarks: String(user.bankRemarks || "Anything about bank details"),
      },
      "Contact Information": {
        Mobile: mobileNo,
        "Email Id": emailId,
      },
      "e-KYC Customer": {
        poa: {
          co: String(user.poaCo || "S/O: Parent Name"),
          street: String(user.poaStreet || "Main Street"),
          house: String(user.poaHouse || "House 1"),
          lm: String(user.poaLm || "Near Park"),
          vtc: String(user.poaVtc || "City Center"),
          subdist: String(user.poaSubdist || "District Sub"),
          dist: city,
          state: state,
          pc: pinCode,
          po: String(user.poaPo || "Main Post Office"),
        },
        aadhar_no: userAadhaar,
        name: `${firstName} ${lastName}`,
        dob: formattedDob,
        gender: formatGenderShort(user.gender),
        "compressed-address": String(user.compressedAddress || `${address}, ${city}, ${state}\n${pinCode}`),
      },
    };

    const response = await axios.post(CREATE_CUSTOMER_URL, payload, {
      headers: getHeaders(payload),
    });
    return response.data;
  } catch (error) {
    return {
      status: "ERROR",
      message: error.message,
      errorData: error.response?.data || error.message,
    };
  }
}

// Workflow controller for a single lead
async function processCasheLead(lead) {
  const mobile = lead.phone || lead.mobile || lead.contact || "";
  const email = lead.email || "test@gmail.com";

  const duplicateRes = await checkDuplicateLead(mobile, email);
  const casheResponse = { DuplicateCheck: duplicateRes };

  const canProceed = duplicateRes?.duplicateStatusCode === 1;
  if (!canProceed) {
    return {
      isEligible: false,
      casheData: casheResponse,
      status: "SKIPPED_NOT_ELIGIBLE",
    };
  }

  const preApprovalRes = await getPreApproval(lead);
  casheResponse.PreApproval = preApprovalRes;

  const approvalAmount = preApprovalRes?.payLoad?.amount;
  const approvalStatus = preApprovalRes?.payLoad?.status;

  const isAmountValid =
    approvalAmount !== null &&
    approvalAmount !== undefined &&
    approvalStatus !== "rejected";

  if (!isAmountValid) {
    return {
      isEligible: false,
      casheData: casheResponse,
      status: "PRE_APPROVAL_AMOUNT_NULL_OR_REJECTED",
    };
  }

  const createCustomerRes = await createCustomer(lead, approvalAmount);
  casheResponse.CreateCustomer = createCustomerRes;

  return {
    isEligible: true,
    casheData: casheResponse,
    status: "SUCCESS_PROCESSED",
  };
}

// Individual Worker Loop to process records independently
async function workerLoop(workerId) {
  console.log(`👷 Worker #${workerId} started...`);
  try {
    while (true) {
      const leads = await UserDB.aggregate([
        {
          $match: {
            "RefArr.name": { $nin: ["cashe"] },
          },
        },
        { $limit: BATCH_SIZE },
      ]);

      if (leads.length === 0) {
        console.log(`✅ Worker #${workerId}: No more leads to process. Exiting worker.`);
        break;
      }

      for (const lead of leads) {
        const mobileNumber = lead.phone || lead.mobile || lead.contact;
        if (!mobileNumber) {
          await UserDB.updateOne(
            { _id: lead._id },
            { $push: { RefArr: { name: "cashe", createdAt: new Date().toISOString() } } }
          );
          continue;
        }

        console.log(`⚙️ [Worker #${workerId}] Processing: ${mobileNumber}`);
        const apiResult = await processCasheLead(lead);

        const updateDoc = {
          $push: {
            apiResponse: {
              name: "cashe",
              ...apiResult.casheData,
              createdAt: new Date().toISOString(),
            },
            RefArr: {
              name: "cashe",
              createdAt: new Date().toISOString(),
            },
          },
        };

        await UserDB.updateOne({ _id: lead._id }, updateDoc);

        globalSuccessCount++;
        globalTotalLeads++;
        console.log(`✅ [Worker #${workerId}] Done: ${mobileNumber} [Status: ${apiResult.status}] (Total Success: ${globalSuccessCount})`);
      }

      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
  } catch (error) {
    console.error(`❌ Worker #${workerId} error:`, error.message);
  }
}

async function start() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ MongoDB Connected Successfully. Launching 4 Parallel Workers...");

    const workers = [];
    for (let i = 1; i <= NUM_WORKERS; i++) {
      workers.push(workerLoop(i));
    }

    await Promise.all(workers);

    console.log(`🎉 All tasks completed! Total Processed Successfully: ${globalSuccessCount}`);
  } catch (error) {
    console.log("🚫 Main Process Error:", error);
  } finally {
    console.log("🔌 Closing database connection...");
    await mongoose.connection.close();
    process.exit(0);
  }
}

start();