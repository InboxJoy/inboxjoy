export function providerCircuitKeySql(alias: string): string {
  return `CASE WHEN ${alias}.provider = 'smtp' THEN 'smtp:' || ${alias}.id::text ELSE ${alias}.provider::text END`;
}

export function providerCircuitKey(provider: string, emailAccountId: string): string {
  return provider === "smtp" ? `smtp:${emailAccountId}` : provider;
}
