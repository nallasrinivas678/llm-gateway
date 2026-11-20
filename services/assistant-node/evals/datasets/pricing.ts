import type { EvalDataset } from "../types.js";

// A made-up price list that is mostly tables, where text extraction and chunking are most likely to
// break up the numbers.
export const pricing: EvalDataset = {
  name: "pricing",
  pages: [
    [
      "CLOUDBRIGHT PRICE LIST 2027 - All prices in US dollars",
      "Plans",
      "Plan | Users | Storage | Monthly price | Annual price",
      "Starter | 5 | 100 GB | 29 | 290",
      "Team | 25 | 1 TB | 99 | 990",
      "Business | 100 | 5 TB | 299 | 2,990",
      "Enterprise | Unlimited | Custom | Contact sales | Contact sales",
      "Prices are per workspace. Annual plans are paid in one payment at the start of the year.",
    ],
    [
      "Add-ons",
      "Add-on | Unit | Monthly price",
      "Extra user | per user | 6",
      "Extra storage | per 100 GB | 12",
      "Priority support | per workspace | 49",
      "Single sign-on (SSO) | per workspace | 79",
      "Audit log, one year retention | per workspace | 25",
      "The audit log with 90 days of retention is included in every plan at no charge.",
      "Add-ons can be started or stopped at any time and are billed on the next invoice.",
    ],
    [
      "Usage limits",
      "Plan | API calls per day | Maximum file upload",
      "Starter | 10,000 | 2 GB",
      "Team | 100,000 | 5 GB",
      "Business | 1,000,000 | 20 GB",
      "API calls above the daily limit are charged at 0.40 dollars per 1,000 calls.",
      "Calls are counted per workspace from midnight UTC. Usage resets every day at midnight UTC.",
    ],
    [
      "Billing and refunds",
      "Annual billing is equal to ten months of the monthly price, so two months are free.",
      "Every new customer can request a full refund within 30 days of the first purchase.",
      "Business customers can pay by invoice with payment terms of net 30 days.",
      "Every plan except Enterprise starts with a free 14 day trial. No credit card is needed for the trial.",
      "Taxes are not included in the prices above and are added at checkout where they apply.",
    ],
  ],
  questions: [
    { id: "pricing-01", question: "What does the Team plan cost per month?", type: "table-or-number", goldPages: [1], mustInclude: ["99"] },
    { id: "pricing-02", question: "What is the annual price of the Business plan?", type: "table-or-number", goldPages: [1], mustInclude: ["2990"] },
    { id: "pricing-03", question: "How many users does the Starter plan include?", type: "table-or-number", goldPages: [1], mustInclude: ["5|five"] },
    { id: "pricing-04", question: "How much does extra storage cost?", type: "table-or-number", goldPages: [2], mustInclude: ["12"] },
    { id: "pricing-05", question: "What does single sign-on cost?", type: "table-or-number", goldPages: [2], mustInclude: ["79"] },
    { id: "pricing-06", question: "How many API calls per day does the Team plan allow?", type: "table-or-number", goldPages: [3], mustInclude: ["100000"] },
    { id: "pricing-07", question: "What is the charge for API calls above the daily limit?", type: "table-or-number", goldPages: [3], mustInclude: ["0.40"] },
    { id: "pricing-08", question: "How long is the refund window?", type: "lookup", goldPages: [4], mustInclude: ["30"] },
    { id: "pricing-09", question: "How long is the free trial?", type: "lookup", goldPages: [4], mustInclude: ["14"] },
    {
      id: "pricing-10",
      question: "How much would the Team plan with priority support cost per month in total?",
      type: "multi-page",
      goldPages: [1, 2],
      mustInclude: ["148"],
      derived: true,
    },
    { id: "pricing-11", question: "Is there a student discount?", type: "unanswerable", goldPages: [], mustInclude: [] },
    { id: "pricing-12", question: "Does the Enterprise plan come with a dedicated account manager?", type: "unanswerable", goldPages: [], mustInclude: [] },
  ],
};
