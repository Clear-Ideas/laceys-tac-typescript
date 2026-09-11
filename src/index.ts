/**
 * Twilio Agent Connect
 *
 * Single entry point that composes all sub-packages.
 * Consumers import everything from 'twilio-agent-connect'.
 */

// Core — all types, classes, and utilities
export * from '@twilio/tac-core';

// Tools — TACTool class, defineTool, and built-in tool creators
export * from '@twilio/tac-tools';

// Server — TACServer and its config
export * from '@twilio/tac-server';
