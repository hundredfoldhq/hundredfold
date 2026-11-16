import { describe, expect, it } from "vitest";
import { scrubListedEnv, scrubListValue } from "../scrub-list-env.js";

describe("scrubListValue", () => {
  it("joins the distinct names, and says nothing for none", () => {
    expect(scrubListValue(["A_KEY", "B_KEY", "A_KEY"])).toBe("A_KEY,B_KEY");
    expect(scrubListValue([])).toBeUndefined();
    expect(scrubListValue(undefined)).toBeUndefined();
  });
});

describe("scrubListedEnv", () => {
  it("deletes each listed name, tolerating blanks and spaces, and the list itself", () => {
    const env: NodeJS.ProcessEnv = { HUNDREDFOLD_SCRUB_ENV: "A_KEY, B_KEY,,", A_KEY: "1", B_KEY: "2", C_KEY: "3" };
    scrubListedEnv(env);
    expect(env).toEqual({ C_KEY: "3" });
  });

  it("leaves an environment with no list alone", () => {
    const env: NodeJS.ProcessEnv = { A_KEY: "1" };
    scrubListedEnv(env);
    expect(env).toEqual({ A_KEY: "1" });
  });

  it("always drops the opencode server password, with or without a list", () => {
    const bare: NodeJS.ProcessEnv = { OPENCODE_SERVER_PASSWORD: "pw", A_KEY: "1" };
    scrubListedEnv(bare);
    expect(bare).toEqual({ A_KEY: "1" });
    const listed: NodeJS.ProcessEnv = { OPENCODE_SERVER_PASSWORD: "pw", HUNDREDFOLD_SCRUB_ENV: "A_KEY", A_KEY: "1", C_KEY: "3" };
    scrubListedEnv(listed);
    expect(listed).toEqual({ C_KEY: "3" });
  });
});
