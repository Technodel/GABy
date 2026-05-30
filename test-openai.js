const { generateText } = require('ai');
const { createOpenAI } = require('@ai-sdk/openai');

async function main() {
  console.log("Starting test...");
  try {
    const openai = createOpenAI({ apiKey: "AIzaSy_fake_gemini_key" });
    const model = openai("gpt-3.5-turbo");
    const result = await generateText({
      model,
      prompt: "Hello",
    });
    console.log("Result:", result.text);
  } catch (err) {
    console.error("Caught error:", err.message);
  }
}

main();
