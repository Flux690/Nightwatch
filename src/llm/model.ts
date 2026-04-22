import { GoogleGenAI } from "@google/genai";

let _gemini: GoogleGenAI | null = null;

export const gemini = new Proxy({} as GoogleGenAI, {
  get(_target, prop, receiver) {
    if (!_gemini) {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error(
          "GEMINI_API_KEY environment variable is not set.\n" +
          "  export GEMINI_API_KEY=your-key-here",
        );
      }
      _gemini = new GoogleGenAI({ apiKey });
    }
    return Reflect.get(_gemini, prop, receiver);
  },
});
