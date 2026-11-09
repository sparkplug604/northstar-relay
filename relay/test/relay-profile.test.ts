import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PersonForm, VerifyPhone } from "../apps/web/src/relay/People.js";
import type { Person, Session } from "../apps/web/src/relay/api.js";

const person: Person = { id: "person-1", displayName: "Test Administrator", email: "admin@example.test", role: "organization_admin", branchId: "branch-1", active: true, phone: "+16045550123", phoneVerified: false };
const session: Session = { user: person, organization: { id: "organization-1", name: "Test Organization" }, branches: [{ id: "branch-1", name: "Test Branch", timezone: "America/Vancouver" }], csrfToken: "test-csrf", providerMode: "simulated" };
const noop = () => undefined;

test("Relay self-profile editing exposes contact details without account-management controls", () => {
  const html = renderToStaticMarkup(createElement(PersonForm, { session, person, language: "en", selfProfile: true, onSaved: noop, onCancel: noop }));
  assert.match(html, /Edit my details/);
  assert.match(html, /name="displayName"/);
  assert.match(html, /name="phone"/);
  for (const name of ["active", "email", "password", "role", "branchId"]) assert.doesNotMatch(html, new RegExp(`name="${name}"`));
});

test("Relay People management retains new-account fields and prevents self-deactivation", () => {
  const ownHtml = renderToStaticMarkup(createElement(PersonForm, { session, person, language: "en", onSaved: noop, onCancel: noop }));
  assert.match(ownHtml, /type="checkbox"[^>]*disabled=""/);
  assert.match(ownHtml, /type="hidden"[^>]*name="active"[^>]*value="on"/);
  const newHtml = renderToStaticMarkup(createElement(PersonForm, { session, person: null, language: "en", onSaved: noop, onCancel: noop }));
  for (const name of ["email", "password", "role", "branchId"]) assert.match(newHtml, new RegExp(`name="${name}"`));
});

test("Relay personal phone verification starts with explicit code consent in both languages", () => {
  const html = renderToStaticMarkup(createElement(VerifyPhone, { person, language: "en", selfProfile: true, onVerified: noop, onCancel: noop }));
  assert.match(html, /By requesting a code, you agree/);
  assert.match(html, /Send verification code/);
  assert.doesNotMatch(html, /name="code"/);
  const frenchHtml = renderToStaticMarkup(createElement(VerifyPhone, { person, language: "fr", selfProfile: true, onVerified: noop, onCancel: noop }));
  assert.match(frenchHtml, /vous acceptez de recevoir un texto de vérification/);
  assert.match(frenchHtml, /Envoyer le code de vérification/);
});
