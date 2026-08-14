/**
 * 事件分流判据的钉子（2026-08-14 可维护性行动 C 刀）。
 * 名单成员和过期规则的每一条都对应过一次真实事故 —— 改之前先读这里的案底。
 */
import { describe, it, expect } from 'vitest';
import { STAGE_EVENTS, CHAT_STREAM_EVENTS, isStaleEvent } from './event-router.js';

describe('isStaleEvent —— 过期判据', () => {
  const live = { runId: 'run_a', sessionId: 'sid_a' };

  it('runId / sessionId 有值且不匹配 → 过期', () => {
    expect(isStaleEvent({ runId: 'run_b' }, live)).toBe(true);
    expect(isStaleEvent({ sessionId: 'sid_b' }, live)).toBe(true);
  });

  it('匹配 → 放行', () => {
    expect(isStaleEvent({ runId: 'run_a', sessionId: 'sid_a' }, live)).toBe(false);
  });

  it('事件没带 id → 放行（老事件没 enrich sessionId）', () => {
    expect(isStaleEvent({ type: 'run.delta.text' }, live)).toBe(false);
  });

  it('本地没有基准 → 放行（首条消息 POST 未返回的窗口期，吞了=新一轮开头丢失）', () => {
    expect(isStaleEvent({ runId: 'run_b' }, { runId: null, sessionId: null })).toBe(false);
    expect(isStaleEvent({ sessionId: 'sid_b' }, {})).toBe(false);
  });
});

describe('两张名单 —— 成员资格即行为', () => {
  it('run.start 必须在舞台名单（七修：不在=精灵思考阶段装闲）', () => {
    expect(STAGE_EVENTS.has('run.start')).toBe(true);
    expect(STAGE_EVENTS.has('run.tool_use_summary')).toBe(true);
  });

  it('收场三信号一个不能少（六批：cancelled 曾缺席=取消后精灵永远转圈）', () => {
    for (const t of ['run.done', 'run.error', 'run.cancelled']) {
      expect(STAGE_EVENTS.has(t), t).toBe(true);
    }
  });

  it('run.delta.text 只进聊天不进舞台（语音泡当日拆净，画布不做聊天镜像）', () => {
    expect(CHAT_STREAM_EVENTS.has('run.delta.text')).toBe(true);
    expect(STAGE_EVENTS.has('run.delta.text')).toBe(false);
  });

  it('工具流三件在两张名单都有（旁路语义：又演又折，刻意交集）', () => {
    for (const t of ['run.tool_use.started', 'run.delta.tool_use', 'run.delta.tool_result']) {
      expect(STAGE_EVENTS.has(t) && CHAT_STREAM_EVENTS.has(t), t).toBe(true);
    }
  });

  it('精灵两事件在舞台名单（sprite_summary / recap）', () => {
    expect(STAGE_EVENTS.has('run.sprite_summary')).toBe(true);
    expect(STAGE_EVENTS.has('run.recap')).toBe(true);
  });
});
