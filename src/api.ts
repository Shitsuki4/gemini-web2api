import type { GenerateInput, InputFile, Result, Tool } from "./types";
import { ApiError, uid } from "./util";
import { resolveModel } from "./gemini/models";
function bad(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}
function textContent(content: any, files: InputFile[]): string {
  if (typeof content === "string") return content;
  if (content === null || content === undefined) return "";
  if (!Array.isArray(content))
    return bad("Message content must be a string or content parts");
  return content
    .map((p) => {
      if (!p || typeof p !== "object") return bad("Invalid content part");
      if (
        ["text", "input_text", "output_text"].includes(p.type) &&
        typeof p.text === "string"
      )
        return p.text;
      if (p.type === "image_url" || p.type === "input_image") {
        const url =
          typeof p.image_url === "string" ? p.image_url : p.image_url?.url;
        return attachment(url, "image", files);
      }
      if (p.type === "input_file")
        return attachment(p.file_data, p.filename || "attachment", files);
      return bad(`Unsupported content type: ${String(p.type).slice(0, 60)}`);
    })
    .join("\n");
}
function attachment(url: unknown, name: string, files: InputFile[]) {
  if (typeof url !== "string")
    return bad("Attachment must be a base64 data URL");
  const m = /^data:([\w.+/-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(url);
  if (!m)
    throw new ApiError(
      400,
      "data_url_required",
      "Only base64 data URLs are accepted. Remote URLs are disabled to prevent SSRF.",
    );
  if (!/^(image\/(png|jpeg|webp|gif)|application\/pdf|text\/plain)$/.test(m[1]))
    return bad("Unsupported attachment MIME type");
  if (!m[2] || m[2].length > 1024 * 1024)
    throw new ApiError(
      413,
      "file_too_large",
      "Attachment exceeds the free-tier file limit",
    );
  files.push({
    data: m[2],
    mime: m[1],
    name: name === "image" ? `image.${m[1].split("/")[1]}` : name.slice(0, 120),
  });
  return `[Attached file: ${name}]`;
}
export function normalize(
  body: any,
  endpoint: string,
  owner: string,
  defaultModel: string,
  session?: string,
): GenerateInput {
  for (const option of [
    "temperature",
    "top_p",
    "top_k",
    "max_tokens",
    "max_completion_tokens",
    "max_output_tokens",
    "stop",
    "seed",
    "logprobs",
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "parallel_tool_calls",
    "reasoning",
    "background",
    "store",
    "truncation",
  ]) {
    if (body[option] !== undefined)
      return bad(
        `${option} is not supported by the Gemini web protocol adapter`,
      );
  }
  if (endpoint === "responses" && body.text !== undefined) {
    if (
      !body.text ||
      typeof body.text !== "object" ||
      Object.keys(body.text).some((k) => k !== "format")
    )
      return bad("Only text.format is supported");
    body = { ...body, response_format: body.text.format };
  }
  const model = body.model || defaultModel;
  if (typeof model !== "string") return bad("model must be a string");
  resolveModel(model);
  const files: InputFile[] = [];
  let messages: any[] = body.messages;
  if (endpoint === "responses") {
    const input =
      typeof body.input === "string"
        ? [{ role: "user", content: body.input }]
        : body.input;
    if (!Array.isArray(input)) return bad("input is required");
    if (body.previous_response_id)
      return bad(
        "previous_response_id is not supported; use gemini_session_id and one new message",
      );
    messages = input.map((x: any) => {
      if (!x || typeof x !== "object" || Array.isArray(x))
        return bad("Invalid input item");
      if (x.type === "function_call_output")
        return { role: "tool", tool_call_id: x.call_id, content: x.output };
      if (x.type === "function_call")
        return { role: "assistant", content: JSON.stringify(x) };
      return x;
    });
    if (body.instructions)
      messages = [{ role: "system", content: body.instructions }, ...messages];
  }
  if (!Array.isArray(messages) || !messages.length || messages.length > 128)
    return bad("Provide 1 to 128 messages");
  if (messages.some((m) => !m || typeof m !== "object" || Array.isArray(m)))
    return bad("Invalid message");
  if (
    body.tool_choice !== undefined &&
    body.tool_choice !== "none" &&
    !body.tools?.length
  )
    return bad("tool_choice requires tools");
  if (body.n !== undefined && body.n !== 1) return bad("Only n=1 is supported");
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    return bad("stream must be boolean");
  if (
    session &&
    messages.filter((m) => !["system", "developer"].includes(m.role)).length !==
      1
  )
    return bad(
      "A gateway session ID accepts exactly one new user/tool message (delta mode), not full history",
    );
  if (
    session &&
    messages.some(
      (m) => !["system", "developer", "user", "tool"].includes(m.role),
    )
  )
    return bad("A resumed session accepts a new user or tool message only");
  let hasContent = false;
  let prompt = messages
    .map((m) => {
      if (
        !["user", "assistant", "system", "developer", "tool"].includes(m.role)
      )
        return bad("Unsupported message role");
      let text = textContent(m.content, files);
      if (m.tool_calls) text += "\n" + JSON.stringify(m.tool_calls);
      if (text.trim()) hasContent = true;
      return `[${m.role}${m.tool_call_id ? " " + String(m.tool_call_id).slice(0, 80) : ""}]\n${text}`;
    })
    .join("\n\n");
  if ((!hasContent && !files.length) || prompt.length > 100000)
    return bad("Prompt must be nonempty and at most 100,000 characters");
  if (files.length > 4) return bad("At most four attachments are supported");
  let tools: Tool[] | undefined;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > 32)
      return bad("tools must be an array with at most 32 functions");
    tools = body.tools.map((t: any) =>
      endpoint === "responses" && t?.type === "function"
        ? {
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              strict: t.strict,
            },
          }
        : t,
    );
    for (const t of tools!) {
      if (
        !t ||
        t.type !== "function" ||
        !t.function ||
        !/^[\w-]{1,64}$/.test(t.function.name)
      )
        return bad("Only named function tools are supported");
      if ((t.function as any).strict)
        return bad(
          "Strict function-schema enforcement is unavailable in the Gemini web protocol",
        );
    }
    if (new Set(tools!.map((t) => t.function.name)).size !== tools!.length)
      return bad("Tool names must be unique");
    if (JSON.stringify(tools).length > 40000)
      return bad("Tool definitions exceed 40,000 characters");
    if (body.tool_choice !== "none" && tools!.length) {
      const choice =
        typeof body.tool_choice === "object"
          ? body.tool_choice?.function?.name || body.tool_choice?.name
          : body.tool_choice;
      if (
        choice &&
        choice !== "auto" &&
        choice !== "required" &&
        !tools!.some((t) => t.function.name === choice)
      )
        return bad("Unknown tool_choice");
      prompt +=
        "\n\n[Function interface, prompt-emulated; never execute a function yourself]\n" +
        JSON.stringify(tools) +
        '\nIf a function is needed, reply ONLY with {"tool_calls":[{"name":"function_name","arguments":{}}]}. Otherwise reply normally. Tool choice: ' +
        (choice || "auto");
    }
  }
  // This protocol has no native tool-choice option. In particular, merely
  // suppressing parsed calls does not tell Gemini how to consume a tool result.
  if (body.tool_choice === "none")
    prompt +=
      "\n\n[Function interface, prompt-emulated; tools disabled for this turn]\n" +
      "Tool choice: none. Do not request or execute any function. " +
      "Tool messages already supplied are results of previous calls, not requests to repeat those calls. " +
      "Use the supplied results to answer the user and follow the system/developer instructions.";
  if (body.response_format && body.response_format.type !== "text") {
    if (body.response_format.type !== "json_object")
      return bad(
        "Only text and best-effort json_object response_format are supported",
      );
    prompt += "\n\nReturn ONLY a valid JSON object, without Markdown fences.";
  }
  if (
    resolveModel(model).spark &&
    (files.length ||
      tools?.length ||
      (body.response_format && body.response_format.type !== "text") ||
      !["chat", "responses", "google"].includes(endpoint))
  )
    throw new ApiError(
      400,
      "spark_text_only",
      "Spark currently supports text chat/Responses only, without attachments, function tools or structured output",
    );
  if (prompt.length > 100000)
    return bad("Prompt including tool definitions exceeds 100,000 characters");
  return {
    model,
    prompt,
    files,
    stream: body.stream === true,
    owner,
    session,
    endpoint,
    tools,
    toolChoice: body.tool_choice,
    responseFormat: body.response_format,
    includeUsage: false,
  };
}
export function parseToolCalls(
  text: string,
  tools: Tool[] | undefined,
): any[] | undefined {
  if (!tools?.length) return;
  let data;
  try {
    data = JSON.parse(
      text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""),
    );
  } catch {
    return;
  }
  if (!Array.isArray(data.tool_calls) || !data.tool_calls.length) return;
  if (data.tool_calls.length > 16)
    throw new ApiError(
      502,
      "invalid_tool_call",
      "Too many upstream tool calls",
    );
  return data.tool_calls.map((t: any) => {
    if (
      !tools.some((x) => x.function.name === t.name) ||
      !t.arguments ||
      typeof t.arguments !== "object" ||
      Array.isArray(t.arguments)
    )
      throw new ApiError(
        502,
        "invalid_tool_call",
        "Gemini returned an invalid function call",
      );
    return {
      id: uid("call_"),
      type: "function",
      function: { name: t.name, arguments: JSON.stringify(t.arguments) },
    };
  });
}
export function finishResult(result: Result, input: GenerateInput) {
  result.toolCalls =
    input.toolChoice === "none"
      ? undefined
      : parseToolCalls(result.text, input.tools);
  if (input.toolChoice === "required" && !result.toolCalls)
    throw new ApiError(
      502,
      "tool_required",
      "Gemini did not honor tool_choice=required",
    );
  if (typeof input.toolChoice === "object" && input.toolChoice) {
    const name =
      (input.toolChoice as any).function?.name ||
      (input.toolChoice as any).name;
    if (
      !result.toolCalls?.every((t: any) => t.function.name === name) ||
      !result.toolCalls?.length
    )
      throw new ApiError(
        502,
        "tool_required",
        "Gemini did not honor the requested function",
      );
  }
  if (
    (input.responseFormat as any)?.type === "json_object" &&
    !result.toolCalls
  ) {
    try {
      const parsed = JSON.parse(result.text);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object")
        throw Error();
    } catch {
      throw new ApiError(
        502,
        "invalid_json_response",
        "Gemini did not return a JSON object",
      );
    }
  }
}
export function chatResponse(
  result: Result,
  input: GenerateInput,
  id: string,
  created: number,
) {
  return {
    id,
    object: "chat.completion",
    created,
    model: input.model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: result.toolCalls ? null : result.text,
          ...(result.toolCalls ? { tool_calls: result.toolCalls } : {}),
        },
        finish_reason: result.toolCalls ? "tool_calls" : "stop",
      },
    ],
    gemini: {
      actual_model: result.actualModel || null,
      artifacts: result.artifacts || [],
      ...(result.canvas ? { canvas: result.canvas } : {}),
    },
  };
}
export function responsesResponse(
  result: Result,
  input: GenerateInput,
  id: string,
  created: number,
  status = "completed",
) {
  const output: any[] = result.toolCalls
    ? result.toolCalls.map((t: any) => ({
        id: uid("fc_"),
        type: "function_call",
        status: "completed",
        call_id: t.id,
        name: t.function.name,
        arguments: t.function.arguments,
      }))
    : [
        {
          id: uid("msg_"),
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: result.text, annotations: [] },
          ],
        },
      ];
  return {
    id,
    object: "response",
    created_at: created,
    status,
    error: null,
    incomplete_details: null,
    model: input.model,
    output,
    output_text: result.toolCalls ? "" : result.text,
    parallel_tool_calls: false,
    usage: null,
    gemini: {
      actual_model: result.actualModel || null,
      artifacts: result.artifacts || [],
    },
  };
}
