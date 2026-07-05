// Customer-directory port (design.md D4). BP directory, implemented today by the
// EzyPortalGateway. Refs are opaque TEXT.

export interface CustomerDirectoryPort {
  getCustomer(ref: string): Promise<{ ref: string; name: string; website?: string; email?: string }>;
  searchCustomers(q: string): Promise<Array<{ ref: string; name: string; code: string }>>;
  listContacts(ref: string): Promise<
    Array<{
      ref: string;
      name: string;
      email?: string;
      phone?: string;
      whatsapp?: string;
      telegram?: string;
      isPrimary: boolean;
    }>
  >;
}
