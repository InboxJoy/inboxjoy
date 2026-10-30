// Which product a deployment is.
// "cloud" is the managed service we sell; "selfhost" is the open-source
// edition, where every workspace is entitled and there is no billing.
export type Edition = "cloud" | "selfhost";

export function isCloudEdition(edition: Edition): boolean {
  return edition === "cloud";
}
