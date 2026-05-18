import { URL } from "node:url";

export interface OneInchSwapRequest {
  chainId: number;
  fromTokenAddress: string;
  toTokenAddress: string;
  amount: bigint;
  fromAddress: string;
  receiver: string;
  slippageBps: number;
  protocols?: string[];
  referrerAddress?: string;
  complexityLevel?: number;
  disableEstimate?: boolean;
  allowPartialFill?: boolean;
  includeTokensInfo?: boolean;
  includeProtocols?: boolean;
  includeGas?: boolean;
}

export interface OneInchSwapResponse {
  tx: {
    to: string;
    data: string;
    value?: string;
    gas?: string;
    from?: string;
  };
  dstAmount?: string;
}

export class OneInchClient {
  private readonly apiKey?: string;
  private readonly baseUrl: string;

  constructor(apiKey: string | undefined, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  isEnabled(): boolean {
    return Boolean(this.apiKey);
  }

  async buildSwap(request: OneInchSwapRequest): Promise<OneInchSwapResponse> {
    if (!this.apiKey) {
      throw new Error("ONE_INCH_API_KEY is required for one_inch routes");
    }

    const url = new URL(`${this.baseUrl}/swap/v6.1/${request.chainId}/swap`);
    url.searchParams.set("src", request.fromTokenAddress);
    url.searchParams.set("dst", request.toTokenAddress);
    url.searchParams.set("amount", request.amount.toString());
    url.searchParams.set("from", request.fromAddress);
    url.searchParams.set("receiver", request.receiver);
    url.searchParams.set("slippage", String(request.slippageBps / 100));

    if (request.protocols && request.protocols.length > 0) {
      url.searchParams.set("protocols", request.protocols.join(","));
    }
    if (request.referrerAddress) {
      url.searchParams.set("referrerAddress", request.referrerAddress);
    }
    if (request.complexityLevel !== undefined) {
      url.searchParams.set("complexityLevel", String(request.complexityLevel));
    }
    if (request.disableEstimate !== undefined) {
      url.searchParams.set("disableEstimate", String(request.disableEstimate));
    }
    if (request.allowPartialFill !== undefined) {
      url.searchParams.set("allowPartialFill", String(request.allowPartialFill));
    }
    if (request.includeTokensInfo !== undefined) {
      url.searchParams.set("includeTokensInfo", String(request.includeTokensInfo));
    }
    if (request.includeProtocols !== undefined) {
      url.searchParams.set("includeProtocols", String(request.includeProtocols));
    }
    if (request.includeGas !== undefined) {
      url.searchParams.set("includeGas", String(request.includeGas));
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`1inch swap request failed with status ${response.status}: ${await response.text()}`);
    }

    return (await response.json()) as OneInchSwapResponse;
  }
}
