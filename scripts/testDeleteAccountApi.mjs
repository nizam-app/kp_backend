const BASE = process.env.API_BASE_URL || "http://localhost:5000/api/v1";
const ORIGIN = BASE.replace(/\/api\/v1\/?$/, "");
const PASSWORD = "Password123!";

const request = async (method, path, body, token) => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
};

const assert = (label, condition, detail = "") => {
  if (!condition) {
    throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  }
  console.log(`PASS ${label}`);
};

const registerAndLogin = async (role, email) => {
  const body = {
    email,
    password: PASSWORD,
    role,
  };
  if (role === "MECHANIC") {
    body.fullName = "Delete Test Mechanic";
    body.phone = "+447700900123";
  }

  const register = await request("POST", "/auth/register", body);
  if (register.status !== 201 && register.status !== 200) {
    throw new Error(`Register ${role} failed (${register.status}): ${register.data?.message}`);
  }
  const token = register.data?.data?.accessToken;
  if (!token) {
    throw new Error(`Register ${role} missing accessToken`);
  }
  return token;
};

const runRoleTests = async (role) => {
  const email = `delete-test-${role.toLowerCase()}-${Date.now()}@truckfix.dev`;
  console.log(`\n=== ${role} (${email}) ===`);

  const token = await registerAndLogin(role, email);

  const missingPassword = await request("DELETE", "/users/me", {}, token);
  assert(
    `${role} missing password -> 400`,
    missingPassword.status === 400,
    `got ${missingPassword.status}: ${missingPassword.data?.message}`
  );

  const wrongPassword = await request(
    "DELETE",
    "/users/me",
    { password: "WrongPassword!" },
    token
  );
  assert(
    `${role} wrong password -> 401`,
    wrongPassword.status === 401,
    `got ${wrongPassword.status}: ${wrongPassword.data?.message}`
  );

  const deleted = await request("DELETE", "/users/me", { password: PASSWORD }, token);
  assert(
    `${role} successful delete -> 200`,
    deleted.status === 200 && deleted.data?.data?.deleted === true,
    `got ${deleted.status}: ${deleted.data?.message}`
  );

  const loginAfterDelete = await request("POST", "/auth/login", {
    email,
    password: PASSWORD,
  });
  assert(
    `${role} login after delete -> 401`,
    loginAfterDelete.status === 401,
    `got ${loginAfterDelete.status}: ${loginAfterDelete.data?.message}`
  );
};

const runSeededUserBlockedTest = async () => {
  console.log("\n=== Seeded fleet blocked delete (linked data) ===");
  const login = await request("POST", "/auth/login", {
    email: "fleet@truckfix.dev",
    password: PASSWORD,
  });
  assert(
    "seeded fleet login",
    login.status === 200,
    `got ${login.status}: ${login.data?.message}`
  );

  const token = login.data?.data?.accessToken;
  const blocked = await request("DELETE", "/users/me", { password: PASSWORD }, token);
  assert(
    "seeded fleet delete blocked -> 400",
    blocked.status === 400,
    `got ${blocked.status}: ${blocked.data?.message}`
  );
  console.log(`  message: ${blocked.data?.message}`);
};

const main = async () => {
  console.log(`Testing DELETE ${BASE}/users/me`);

  const healthRes = await fetch(`${ORIGIN}/health`);
  assert("server health", healthRes.ok, `status ${healthRes.status}`);

  await runRoleTests("FLEET");
  await runRoleTests("MECHANIC");
  await runSeededUserBlockedTest();

  console.log("\nAll delete-account API tests passed.");
};

main().catch((err) => {
  console.error("\nTEST FAILURE:", err.message);
  process.exit(1);
});
