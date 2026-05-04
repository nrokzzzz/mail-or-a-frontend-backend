const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.classifyEmail = async (subject, body) => {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json" },
    });

    const today    = new Date().toISOString().split("T")[0];
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().split("T")[0];

    const prompt = `
You are a specialized Email Classifier for a job and opportunity tracker. Your task is to extract structured data from emails into a specific JSON schema.

### Classification Rules:
- CATEGORY: "job", "internship", "hackathon", "workshop", or "other".
- STAGE:
    - "registration": Has a CTA to apply/register (e.g., "Apply Now", "Register here").
    - "registered": Confirmation of receipt (e.g., "Application received", "Successfully registered").
    - "inprogress": Interviews, coding rounds, or technical assessments.
    - "confirmed": Offer letters, acceptance, or onboarding.
    - "other": General news or non-specific updates.

### Deadline Extraction Rules:
- If a deadline is explicitly mentioned, return it in YYYY-MM-DD.
- If no deadline is found AND stage is "registration", "inprogress", or "other", return ${tomorrow}.
- For stages "registered" and "confirmed", ALWAYS return null.

### Output Format:
Return ONLY a valid JSON object. Do not include markdown code blocks or conversational text.
{
  "category": "string",
  "stage": "string",
  "deadline": "YYYY-MM-DD or null"
}

Today's date: ${today}
Subject: ${subject}
Body: ${body}
    `;

    const result = await model.generateContent(prompt);

    return JSON.parse(result.response.text());
  } catch (error) {
    console.error("Gemini Classification Error:", error.message);
    throw error;
  }
};
