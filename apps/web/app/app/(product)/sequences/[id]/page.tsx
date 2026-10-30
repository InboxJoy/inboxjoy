"use client";

import { useParams } from "next/navigation";
import { SequenceDetail } from "./sequence-detail";

export default function CampaignPage() {
  const params = useParams<{ id: string }>();
  return <SequenceDetail campaignId={params.id} />;
}
