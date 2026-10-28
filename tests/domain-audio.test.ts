import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import { AssetSchema } from "@/lib/domain/asset";
import { createCharacter, setCharacterReference } from "@/lib/domain/library";
import { averyBible } from "./support/domain-fixtures";

const NOW = 1_760_000_000_000;

function asset(overrides: Record<string, unknown>) {
  return {
    id: randomUUID(),
    projectId: null,
    kind: "audio",
    mime: "audio/flac",
    relativePath: "references/voice.flac",
    width: 0,
    height: 0,
    sha256: "a".repeat(64),
    provenance: { source: "upload", name: "voice.m4a", originalSha256: "b".repeat(64) },
    state: { state: "active" },
    audio: { durationSeconds: 8.2, codec: "flac" },
    revision: 0,
    createdAt: NOW,
    ...overrides,
  };
}

describe("audio assets", () => {
  test("audio assets carry playback metadata and no size; images keep their size", () => {
    const voice = AssetSchema.parse(asset({}));
    assert.equal(voice.kind, "audio");
    assert.equal(AssetSchema.safeParse(asset({ audio: undefined })).success, false);
    assert.equal(AssetSchema.safeParse(asset({ width: 100, height: 100 })).success, false);
    assert.equal(AssetSchema.safeParse(asset({ mime: "image/png" })).success, false);
    assert.equal(AssetSchema.safeParse(asset({ kind: "image", mime: "image/png", relativePath: "references/a.png", audio: undefined })).success, false);
    assert.ok(AssetSchema.safeParse(asset({ kind: "image", mime: "image/png", relativePath: "references/a.png", audio: undefined, width: 10, height: 10 })).success);
    assert.ok(AssetSchema.safeParse(asset({ provenance: { source: "derived", fromAssetId: randomUUID(), method: "audio_track" }, audio: { durationSeconds: 5, codec: "flac", transcript: "Still cold." } })).success);
  });

  test("a character's voice reference takes an audio asset only, and does not need the face", () => {
    const character = createCharacter(randomUUID(), averyBible(), NOW);
    const voice = AssetSchema.parse(asset({}));
    const withVoice = setCharacterReference(character, "voice", voice, NOW + 1);
    assert.equal(withVoice.bible.references.voiceAssetId, voice.id);
    assert.equal(withVoice.bible.version, character.bible.version + 1);
    const image = AssetSchema.parse(asset({ kind: "image", mime: "image/png", relativePath: "references/a.png", audio: undefined, width: 10, height: 10 }));
    assert.throws(() => setCharacterReference(character, "voice", image, NOW), /audio recording/);
    assert.throws(() => setCharacterReference(character, "face", voice, NOW), /still images/);
  });
});
