import type { FailedLoginIp } from "./types.js";

export interface PendingFailedLogins {
  attempts: number;
  first_attempt_at: string;
  ips: Map<string, FailedLoginIp>;
}

/**
 * Counts failed sign-in attempts of every user in memory until they are drained into one record per user.
 */
export class FailedLoginsBuffer {
  private pending = new Map<string, PendingFailedLogins>();

  constructor(private readonly maxIps: number) {}

  /**
   * Country is resolved only for the first attempt from an IP, other attempts from it just increase its count.
   */
  async add(pk: string, ip: string | null, resolveCountry: () => Promise<string | null>) {
    let userLogins = this.pending.get(pk);
    if (!userLogins) {
      userLogins = { attempts: 0, first_attempt_at: new Date().toISOString(), ips: new Map() };
      this.pending.set(pk, userLogins);
    }
    userLogins.attempts++;

    // unknown IP is only counted in attempts
    if (!ip) {
      return;
    }
    const known = userLogins.ips.get(ip);
    if (known) {
      known.attempts++;
      return;
    }
    if (userLogins.ips.size >= this.maxIps) {
      return;
    }
    // added before the country is resolved, so parallel attempts from the IP don't resolve it again
    const entry: FailedLoginIp = { attempts: 1, country: null };
    userLogins.ips.set(ip, entry);
    entry.country = await resolveCountry();
  }

  /**
   * Returns attempts counted since the previous call by user pk and starts counting from zero.
   */
  drain(): Map<string, PendingFailedLogins> {
    const drained = this.pending;
    this.pending = new Map();
    return drained;
  }
}
