/** One system parameter (FR-5.4). Values are stored as strings; parse returns undefined when invalid. */
interface ConfigDef<T> {
  default: string;
  description: string;
  parse(raw: string): T | undefined;
}

const def = <T>(d: ConfigDef<T>) => d;

const integer = (min: number, max: number) => (raw: string) =>
  /^\d{1,9}$/.test(raw) && Number(raw) >= min && Number(raw) <= max ? Number(raw) : undefined;

/** "HH:MM" before 12:00, so the monthly HRS export is ready by noon on day 1 (FR-4.3). */
const morningTime = (raw: string) => (/^(0\d|1[01]):[0-5]\d$/.test(raw) ? raw : undefined);

/** http(s) URL, or empty to use the environment value. Credentials never live here: they stay in env. */
const baseUrl = (raw: string) => {
  if (raw === '') return raw;
  try {
    const { protocol } = new URL(raw);
    return protocol === 'http:' || protocol === 'https:' ? raw : undefined;
  } catch {
    return undefined;
  }
};

export const CONFIG = {
  'qr.ttlSeconds': def({
    default: '60',
    description: 'QR token validity in seconds, 30 to 300 (ADR-10)',
    parse: integer(30, 300),
  }),
  'gate.antiPassbackSeconds': def({
    default: '60',
    description: 'Anti-passback window in seconds, 0 to 3600 (FR-2.5)',
    parse: integer(0, 3600),
  }),
  'attendance.lateGraceMinutes': def({
    default: '5',
    description: 'Late-arrival grace period in minutes, 0 to 120',
    parse: integer(0, 120),
  }),
  'export.monthlyAt': def({
    default: '06:00',
    description: 'Time of day (HH:MM, 00:00 to 11:59) the monthly HRS export runs (FR-4.3)',
    parse: morningTime,
  }),
  'retention.attendanceYears': def({
    default: '5',
    description: 'Years attendance is retained, 5 to 20 (NFR)',
    parse: integer(5, 20),
  }),
  'retention.auditMonthsOnline': def({
    default: '12',
    description: 'Months the audit log stays online, 12 to 120 (NFR)',
    parse: integer(12, 120),
  }),
  'integration.tcsBaseUrl': def({
    default: '',
    description: 'TCS base URL (http or https); empty uses the environment value (FR-5.6)',
    parse: baseUrl,
  }),
  'integration.hrsBaseUrl': def({
    default: '',
    description: 'HRS base URL (http or https); empty uses the environment value (FR-5.6)',
    parse: baseUrl,
  }),
} as const;

export type ConfigKey = keyof typeof CONFIG;

/** The parsed type of each key. */
export type ConfigValues = {
  [K in ConfigKey]: NonNullable<ReturnType<(typeof CONFIG)[K]['parse']>>;
};

export const isConfigKey = (key: string): key is ConfigKey =>
  Object.prototype.hasOwnProperty.call(CONFIG, key);

/** The parsed value of a stored string, or of the default when it is missing or invalid. */
export const parseConfig = <K extends ConfigKey>(
  key: K,
  raw: string | undefined,
): ConfigValues[K] =>
  ((raw !== undefined ? CONFIG[key].parse(raw) : undefined) ??
    CONFIG[key].parse(CONFIG[key].default)) as ConfigValues[K];
