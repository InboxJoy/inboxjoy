# AI drafting

InboxJoy can write and refine email drafts for you. This is optional: with no AI
key, everything else works and the AI buttons are simply unavailable. On your
own server you bring the key, so you pay your AI provider directly and choose
the provider.

Three settings in `/opt/inboxjoy/.env` turn it on:

```
AI_API_KEY='sk-...'
AI_MODEL=your-model-name
AI_BASE_URL=https://api.openai.com/v1
```

- `AI_API_KEY` and `AI_MODEL` are both needed.
- `AI_BASE_URL` is optional. It defaults to OpenAI's address. Change it to use
  any other service that speaks the same API (most do).

Then run `inboxjoy restart`. Keep the single quotes around the key if it could
contain a `$` sign.

## Which model

Drafting writes short emails, so a small, fast and cheap model is usually
enough. Use the exact model name from your provider's list. If drafts come back
empty or oddly formatted, try a larger model before anything else.

## Providers

| Service | `AI_BASE_URL` | Notes |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` (the default) | Create a key at platform.openai.com |
| OpenRouter | `https://openrouter.ai/api/v1` | One key for many models; model names look like `vendor/model` |
| Another OpenAI-compatible service | the address from its docs | Together, Groq, Mistral, Fireworks and others |
| Ollama or another model on your own hardware | `http://host.docker.internal:11434/v1` (same server) or `http://10.0.0.5:11434/v1` (another machine) | Set any value for `AI_API_KEY`; the model must already be pulled, and the server must accept connections from Docker |

For a model running on the same server, the API and worker containers can reach
the server as `host.docker.internal`. The model server must listen on an
address Docker can reach, not only on `127.0.0.1`. For Ollama, set
`OLLAMA_HOST=0.0.0.0` and protect the port with your firewall, because Ollama
has no password of its own.

## What is sent

When you ask for a draft, InboxJoy sends your prompt, your sequence copy and the
details of the lead it is writing to (name, company and the other fields you
use as variables) to the AI service you configured. Nothing else leaves your
server, and nothing is sent unless someone presses an AI button. Read your AI
provider's data policy before using real lead data.

## Check that it works

Open a sequence, add a step and use the AI draft button. If it fails, run
`inboxjoy logs api` and look for the provider's error. The usual causes are a
wrong model name, a key without access to that model, a billing limit, or a
wrong `AI_BASE_URL` (it must end in `/v1` for most services).
