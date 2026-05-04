const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize the SDK with your API Key
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.extractSkills = async (resumeText) => {
    try {
        // Access the specific model
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash", // Use the updated 2.5 version
            generationConfig: { responseMimeType: "application/json" }
        });

        const prompt = `
      Extract only technical skills from this resume text.
      Return a JSON array of strings.

      Resume:
      ${resumeText}
    `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        // Since we requested application/json, we can parse it directly
        return JSON.parse(text);

    } catch (error) {
        console.error("Gemini Full Error:", error);
        throw error; // don't wrap it
    }
};