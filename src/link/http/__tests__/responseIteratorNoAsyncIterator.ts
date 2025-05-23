import gql from "graphql-tag";
import { execute } from "../../core/execute";
import { HttpLink } from "../HttpLink";
import { TextEncoder, TextDecoder } from "util";
import { ReadableStream } from "web-streams-polyfill";
import { Readable } from "stream";
import { ObservableStream } from "../../../testing/internal";

// As of Jest 26 there is no way to mock/unmock a module that is used indirectly
// via a single test file.
// These tests duplicate __tests__/responseIterator.ts while mocking
// `isAsyncIterableIterator = false` in order to test the integration of the
// implementations inside /iterators via src/link/http/responseIterator.ts
// which do not execute when isAsyncIterableIterator is true
// See: https://github.com/facebook/jest/issues/2582#issuecomment-655110424

jest.mock("../../../utilities/index.js", () => ({
  __esModule: true,
  ...jest.requireActual("../../../utilities/index.js"),
  canUseAsyncIteratorSymbol: false,
}));

const sampleDeferredQuery = gql`
  query SampleDeferredQuery {
    stub {
      id
      ... on Stub @defer {
        name
      }
    }
  }
`;

const BOUNDARY = "gc0p4Jq0M2Yt08jU534c0p";

describe("multipart responses", () => {
  let originalTextDecoder: any;
  beforeAll(() => {
    originalTextDecoder = TextDecoder;
    (globalThis as any).TextDecoder = TextDecoder;
  });

  afterAll(() => {
    globalThis.TextDecoder = originalTextDecoder;
  });

  const bodyCustomBoundary = [
    `--${BOUNDARY}`,
    "Content-Type: application/json; charset=utf-8",
    "Content-Length: 43",
    "",
    '{"data":{"stub":{"id":"0"}},"hasNext":true}',
    `--${BOUNDARY}`,
    "Content-Type: application/json; charset=utf-8",
    "Content-Length: 58",
    "",
    '{"hasNext":false, "incremental": [{"data":{"name":"stubby"},"path":["stub"]}]}',
    `--${BOUNDARY}--`,
  ].join("\r\n");

  const bodyDefaultBoundary = [
    `---`,
    "Content-Type: application/json; charset=utf-8",
    "Content-Length: 43",
    "",
    '{"data":{"stub":{"id":"0"}},"hasNext":true}',
    `---`,
    "Content-Type: application/json; charset=utf-8",
    "Content-Length: 58",
    "",
    '{"hasNext":false, "incremental": [{"data":{"name":"stubby"},"path":["stub"]}]}',
    `-----`,
  ].join("\r\n");

  const bodyBatchedResults = [
    "--graphql",
    "content-type: application/json",
    "",
    '{"data":{"allProducts":[{"delivery":{"__typename":"DeliveryEstimates"},"sku":"federation","id":"apollo-federation","__typename":"Product"},{"delivery":{"__typename":"DeliveryEstimates"},"sku":"studio","id":"apollo-studio","__typename":"Product"}]},"hasNext":true}',
    "--graphql",
    "content-type: application/json",
    "",
    '{"hasNext":true,"incremental":[{"data":{"estimatedDelivery":"6/25/2021","fastestDelivery":"6/24/2021","__typename":"DeliveryEstimates"},"path":["allProducts",0,"delivery"]},{"data":{"estimatedDelivery":"6/25/2021","fastestDelivery":"6/24/2021","__typename":"DeliveryEstimates"},"path":["allProducts",1,"delivery"]}]}',
    "--graphql",
    "content-type: application/json",
    "",
    '{"hasNext":false}',
    "--graphql--",
  ].join("\r\n");

  const results = [
    {
      data: {
        stub: {
          id: "0",
        },
      },
      hasNext: true,
    },
    {
      incremental: [
        {
          data: {
            name: "stubby",
          },
          path: ["stub"],
        },
      ],
      hasNext: false,
    },
  ];

  const batchedResults = [
    {
      data: {
        allProducts: [
          {
            __typename: "Product",
            delivery: {
              __typename: "DeliveryEstimates",
            },
            id: "apollo-federation",
            sku: "federation",
          },
          {
            __typename: "Product",
            delivery: {
              __typename: "DeliveryEstimates",
            },
            id: "apollo-studio",
            sku: "studio",
          },
        ],
      },
      hasNext: true,
    },
    {
      hasNext: true,
      incremental: [
        {
          data: {
            __typename: "DeliveryEstimates",
            estimatedDelivery: "6/25/2021",
            fastestDelivery: "6/24/2021",
          },
          path: ["allProducts", 0, "delivery"],
        },
        {
          data: {
            __typename: "DeliveryEstimates",
            estimatedDelivery: "6/25/2021",
            fastestDelivery: "6/24/2021",
          },
          path: ["allProducts", 1, "delivery"],
        },
      ],
    },
  ];

  it("can handle whatwg stream bodies", async () => {
    const stream = new ReadableStream({
      async start(controller) {
        const lines = bodyCustomBoundary.split("\r\n");
        try {
          for (const line of lines) {
            controller.enqueue(line + "\r\n");
          }
        } finally {
          controller.close();
        }
      },
    });

    const fetch = jest.fn(async () => ({
      status: 200,
      body: stream,
      headers: new Headers({
        "content-type": `multipart/mixed; boundary=${BOUNDARY}`,
      }),
    }));

    const link = new HttpLink({
      fetch: fetch as any,
    });

    const observable = execute(link, { query: sampleDeferredQuery });
    const observableStream = new ObservableStream(observable);

    for (const result of results) {
      await expect(observableStream).toEmitValue(result);
    }

    await expect(observableStream).toComplete();
  });

  it("can handle whatwg stream bodies with arbitrary splits", async () => {
    const stream = new ReadableStream({
      async start(controller) {
        let chunks: Array<string> = [];
        let chunkSize = 15;
        for (let i = 0; i < bodyCustomBoundary.length; i += chunkSize) {
          chunks.push(bodyCustomBoundary.slice(i, i + chunkSize));
        }

        try {
          for (const chunk of chunks) {
            controller.enqueue(chunk);
          }
        } finally {
          controller.close();
        }
      },
    });

    const fetch = jest.fn(async () => ({
      status: 200,
      body: stream,
      headers: new Headers({
        "content-type": `multipart/mixed; boundary=${BOUNDARY}`,
      }),
    }));

    const link = new HttpLink({
      fetch: fetch as any,
    });

    const observable = execute(link, { query: sampleDeferredQuery });
    const observableStream = new ObservableStream(observable);

    for (const result of results) {
      await expect(observableStream).toEmitValue(result);
    }

    await expect(observableStream).toComplete();
  });

  it("can handle node stream bodies (strings) with default boundary", async () => {
    const stream = Readable.from(
      bodyDefaultBoundary.split("\r\n").map((line) => line + "\r\n")
    );

    const fetch = jest.fn(async () => ({
      status: 200,
      body: stream,
      // if no boundary is specified, default to -
      headers: new Headers({
        "content-type": `multipart/mixed`,
      }),
    }));
    const link = new HttpLink({
      fetch: fetch as any,
    });

    const observable = execute(link, { query: sampleDeferredQuery });
    const observableStream = new ObservableStream(observable);

    for (const result of results) {
      await expect(observableStream).toEmitValue(result);
    }

    await expect(observableStream).toComplete();
  });

  it("can handle node stream bodies (strings) with arbitrary splits", async () => {
    let chunks: Array<string> = [];
    let chunkSize = 15;
    for (let i = 0; i < bodyCustomBoundary.length; i += chunkSize) {
      chunks.push(bodyCustomBoundary.slice(i, i + chunkSize));
    }
    const stream = Readable.from(chunks);

    const fetch = jest.fn(async () => ({
      status: 200,
      body: stream,
      headers: new Headers({
        "content-type": `multipart/mixed; boundary=${BOUNDARY}`,
      }),
    }));
    const link = new HttpLink({
      fetch: fetch as any,
    });

    const observable = execute(link, { query: sampleDeferredQuery });
    const observableStream = new ObservableStream(observable);

    for (const result of results) {
      await expect(observableStream).toEmitValue(result);
    }

    await expect(observableStream).toComplete();
  });

  it("can handle node stream bodies (array buffers)", async () => {
    const stream = Readable.from(
      bodyDefaultBoundary
        .split("\r\n")
        .map((line) => new TextEncoder().encode(line + "\r\n"))
    );

    const fetch = jest.fn(async () => ({
      status: 200,
      body: stream,
      // if no boundary is specified, default to -
      headers: new Headers({
        "content-type": `multipart/mixed`,
      }),
    }));
    const link = new HttpLink({
      fetch: fetch as any,
    });

    const observable = execute(link, { query: sampleDeferredQuery });
    const observableStream = new ObservableStream(observable);

    for (const result of results) {
      await expect(observableStream).toEmitValue(result);
    }

    await expect(observableStream).toComplete();
  });

  it("can handle node stream bodies (array buffers) with batched results", async () => {
    const stream = Readable.from(
      bodyBatchedResults
        .split("\r\n")
        .map((line) => new TextEncoder().encode(line + "\r\n"))
    );

    const fetch = jest.fn(async () => ({
      status: 200,
      body: stream,
      // if no boundary is specified, default to -
      headers: new Headers({
        "Content-Type": `multipart/mixed;boundary="graphql";deferSpec=20220824`,
      }),
    }));
    const link = new HttpLink({
      fetch: fetch as any,
    });

    const observable = execute(link, { query: sampleDeferredQuery });
    const observableStream = new ObservableStream(observable);

    for (const result of batchedResults) {
      await expect(observableStream).toEmitValue(result);
    }

    await expect(observableStream).toComplete();
  });
});
