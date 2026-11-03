import assert from "node:assert/strict";
import test from "node:test";
import { createCanvaUserAuth } from "../src/canva/canva-user-auth.js";

test("canva user auth needs an app id and at least one allowed team", () => {
  assert.throws(() => createCanvaUserAuth({ appId: "", allowedBrands: ["t"] }), /PIGATEWAY_CANVA_APP_ID/);
  assert.throws(() => createCanvaUserAuth({ appId: "app", allowedBrands: [] }), /PIGATEWAY_CANVA_ALLOWED_BRANDS/);
});

test("canva user auth rejects a token that is not signed by Canva", async () => {
  const auth = createCanvaUserAuth({ appId: "app", allowedBrands: ["t"] });
  await assert.rejects(auth.verify("not.a.jwt"));
});
