export function parseArgs(argv) {
  const values = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      values._.push(token);
      continue;
    }

    const equalsIndex = token.indexOf("=");
    if (equalsIndex > 2) {
      values[token.slice(2, equalsIndex)] = token.slice(equalsIndex + 1);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      values[key] = next;
      index += 1;
    } else {
      values[key] = true;
    }
  }

  return values;
}

export function requiredString(args, name) {
  const value = args[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`缺少必需参数：--${name}`);
  }
  return value.trim();
}

export function stringOption(args, name, fallback) {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

export function integerOption(args, name, fallback, { min, max }) {
  const value = args[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} 必须是 ${min}-${max} 之间的整数`);
  }
  return parsed;
}

export function booleanOption(args, name) {
  const value = args[name];
  if (value === undefined) return false;
  if (value === true) return true;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
