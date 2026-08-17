import { NextResponse } from "next/server";
import { vercelSourceSha } from "@/lib/env";
import { androidPlayerProtocolIdentity } from "@/lib/player/androidPlayerProtocol";

export const dynamic = "force-dynamic";

export function GET(): NextResponse<{
  source_sha: string;
  player_protocol: { version: 2; contract_sha256: string };
}> {
  const playerProtocol = androidPlayerProtocolIdentity();
  return NextResponse.json(
    {
      source_sha: vercelSourceSha(),
      player_protocol: {
        version: playerProtocol.protocolVersion,
        contract_sha256: playerProtocol.protocolContractSha256,
      },
    },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
