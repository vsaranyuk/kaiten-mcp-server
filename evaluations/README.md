# Kaiten MCP Server Evaluations

This directory contains evaluation suites for testing the effectiveness of the Kaiten MCP server when used by LLMs.

## Purpose

Evaluations help measure:
- How well LLMs can use the tools to accomplish real-world tasks
- Tool usability and clarity of documentation
- Performance with complex multi-step workflows
- Error handling and recovery patterns

## Structure

- `kaiten-eval-template.xml` - Template with example evaluation questions
- `custom-eval.xml` - Your custom evaluations based on your Kaiten instance data

## How to Use

1. **Copy the template:**
   ```bash
   cp kaiten-eval-template.xml custom-eval.xml
   ```

2. **Fill in actual data from your Kaiten instance:**
   - Replace placeholder space_ids, board_ids, user names
   - Update expected answers based on your real data
   - Ensure questions are answerable with your current Kaiten data

3. **Run evaluations using MCP evaluation harness:**
   ```bash
   # Install MCP evaluation tools
   npm install -g @modelcontextprotocol/inspector

   # Run evaluations
   mcp-eval run custom-eval.xml
   ```

## Creating Good Evaluation Questions

### Requirements
- ✅ **Independent**: Each question stands alone
- ✅ **Read-only**: Only uses non-destructive operations
- ✅ **Complex**: Requires 2-5 tool calls and reasoning
- ✅ **Realistic**: Based on actual user workflows
- ✅ **Verifiable**: Single, clear, stable answer
- ✅ **Stable**: Answer doesn't change over time

### Question Categories

1. **Search & Discovery** (30%)
   - Finding cards by complex filters
   - Multi-step search refinement
   - Cross-referencing between spaces/boards

2. **Data Aggregation** (25%)
   - Counting cards meeting criteria
   - Finding maxima/minima (oldest, newest, most comments)
   - Analyzing patterns across boards

3. **Relationship Navigation** (25%)
   - Parent/child card relationships
   - User-to-cards mapping
   - Board structure analysis

4. **Workflow Simulation** (20%)
   - Multi-step operations (find user → find their cards → analyze)
   - Board structure discovery workflows
   - Error recovery scenarios

### Example Question Pattern

```xml
<qa_pair>
  <question>
    In the "Engineering" space (space_id: 123), find all cards on the
    "Backend API" board that are marked as ASAP and assigned to user
    "John Smith". Sort by due date and return the card_id of the card
    with the earliest due date. If there are no such cards, answer "NONE".
  </question>
  <answer>45678</answer>
</qa_pair>
```

## Best Practices

1. **Use realistic data**: Base questions on your actual Kaiten usage patterns
2. **Avoid time-dependent answers**: Don't use "created today" or "updated this week"
3. **Test manually first**: Verify you can answer each question using the tools
4. **Document assumptions**: Note any data prerequisites in comments
5. **Keep answers simple**: Prefer numeric IDs or short strings over long text
6. **Include edge cases**: Test error handling (non-existent IDs, empty results)

## Updating Evaluations

Update your evaluation suite when:
- Adding new tools to the MCP server
- Changing tool behavior significantly
- Discovering common user workflows not covered
- Finding tools that are confusing to LLMs

## Metrics to Track

- **Pass Rate**: % of questions answered correctly
- **Tool Efficiency**: Average tool calls per question
- **Error Recovery**: % of questions requiring retry after errors
- **Response Time**: Average time to complete each question

---

*For more information on MCP evaluations, see: https://modelcontextprotocol.io/docs/tools/evaluation*
