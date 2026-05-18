import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { compilePrompt, CompileError } from '@/lib/compiler';

/**
 * POST /api/workflows/compile
 *
 * Compiles a natural-language description into a validated WorkflowSpec
 * and persists it as a DRAFT workflow. The response includes the
 * compiled spec so the UI can render the DAG immediately.
 *
 *   curl -X POST http://localhost:3000/api/workflows/compile \
 *     -H "content-type: application/json" \
 *     -d '{"prompt":"Sweep idle cash over £100k into BlackRock MMF every Friday 4pm","userId":"u_demo"}'
 */

export const runtime = 'nodejs';            // Temporal client uses gRPC

const Body = z.object({
  prompt: z.string().min(10).max(2000),
  userId: z.string().min(1),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. Validate body
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { prompt, userId } = parsed.data;

  // 2. Compile NL → DSL (calls Claude under the hood)
  let spec;
  try {
    spec = await compilePrompt(prompt);
  } catch (err) {
    if (err instanceof CompileError) {
      return NextResponse.json(
        { error: 'compile_failed', message: err.message },
        { status: 422 }
      );
    }
    console.error('compile.unexpected', err);
    return NextResponse.json({ error: 'internal_error' }, { status: 500 });
  }

  // 3. Persist as DRAFT
  const workflow = await prisma.workflow.create({
    data: {
      name: spec.name,
      description: spec.description ?? null,
      prompt,
      spec: spec as never,
      status: 'DRAFT',
      createdById: userId,
    },
  });

  return NextResponse.json({
    workflowId: workflow.id,
    name: workflow.name,
    spec,
  }, { status: 201 });
}
