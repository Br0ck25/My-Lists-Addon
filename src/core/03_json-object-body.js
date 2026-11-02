// Parses a JSON request body and THROWS unless it is a plain object. `null`,
// `[]`, `"x"` and `5` are valid JSON, so a bare `request.json()` succeeds on
// them and the next `body.field` read crashes with a 500. Used inside the
// existing try/catch around the body parse, so every route answers with the
// same "Invalid JSON body." 400 it already gives for broken JSON.
async function readJsonObject(request) {
  const parsed = await request.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyntaxError("JSON body must be an object.");
  }
  return parsed;
}
