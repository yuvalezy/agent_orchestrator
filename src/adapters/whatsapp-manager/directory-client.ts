import { WhatsAppHttp } from './http';

// Read-only directory client over the whatsapp_manager HTTP API (blueprint §1).
// `GET /whitelist` and `GET /groups` return ALL rows (no ?bpId= filter exists) —
// the onboarding CLI client-filters by `ezy_bp_id`. Identity fields mirror
// whatsapp_manager's whitelist.service / group.service row shapes.

/** A whitelist row (a monitored contact). A SUBSET of what `GET /whitelist` returns —
 *  only the fields we read. */
export interface WaWhitelistEntry {
  id: number;
  phone_number: string;
  label: string | null;
  preferred_language: string;
  /** whatsapp_manager's own CHECK constraint: 'male' | 'female' | 'unknown'. The founder
   *  curates this per contact; it exists nowhere in this service's schema. */
  gender: 'male' | 'female' | 'unknown';
  ezy_bp_id: string | null;
  ezy_contact_id: string | null;
  ezy_contact_name: string | null;
}

/** A monitored-group row. `ezy_bp_id` nullable; a group links to a BP, no contact. */
export interface WaGroupEntry {
  id: number;
  group_id: string;
  chat_id: string;
  subject: string | null;
  ezy_bp_id: string | null;
}

interface WaListResponse<T> {
  data: T[];
}

export class WhatsAppDirectoryClient {
  constructor(private readonly http: WhatsAppHttp) {}

  async listWhitelist(): Promise<WaWhitelistEntry[]> {
    const res = await this.http.getJson<WaListResponse<WaWhitelistEntry>>('/whitelist');
    return res.data;
  }

  async listGroups(): Promise<WaGroupEntry[]> {
    const res = await this.http.getJson<WaListResponse<WaGroupEntry>>('/groups');
    return res.data;
  }
}
