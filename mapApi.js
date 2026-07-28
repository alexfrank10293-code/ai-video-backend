import { client } from '@gradio/client';

async function mapSpaces() {
  try {
    console.log("Mapping Kokoro-TTS...");
    const kokoro = await client("hexgrad/Kokoro-TTS");
    console.log("Kokoro-TTS info:");
    console.dir(kokoro.view_api(), { depth: null });
  } catch (e) {
    console.error("Kokoro err", e);
  }

  try {
    console.log("Mapping Wan2.2-T2V...");
    const wanT2V = await client("Wan-AI/Wan2.2-T2V-A14B");
    console.log("Wan2.2-T2V info:");
    console.dir(wanT2V.view_api(), { depth: null });
  } catch (e) {
    console.error("Wan2.2-T2V err", e);
  }

  try {
    console.log("Mapping Wan2.2-TI2V...");
    const wanTI2V = await client("Wan-AI/Wan2.2-TI2V-5B");
    console.log("Wan2.2-TI2V info:");
    console.dir(wanTI2V.view_api(), { depth: null });
  } catch (e) {
    console.error("Wan2.2-TI2V err", e);
  }
}

mapSpaces();
