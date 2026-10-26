#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include "quickjs.h"

enum { SOURCE_MAX = 1048576, OUTPUT_MAX = 524288, INTERRUPT_MAX = 10000 };
static JSRuntime *runtime;
static JSContext *context;
static uint8_t source[SOURCE_MAX + 1];
static uint8_t output[OUTPUT_MAX + 1];
static uint32_t output_length;
static uint32_t interrupts;

static int interrupted(JSRuntime *rt, void *opaque) {
  (void)rt;
  (void)opaque;
  return ++interrupts > INTERRUPT_MAX;
}

static JSModuleDef *deny_module(JSContext *ctx, const char *name, void *opaque) {
  (void)name;
  (void)opaque;
  JS_ThrowTypeError(ctx, "Module imports are unavailable");
  return NULL;
}

uint32_t harness_input(void) { return (uint32_t)(uintptr_t)source; }
uint32_t harness_output(void) { return (uint32_t)(uintptr_t)output; }
uint32_t harness_output_length(void) { return output_length; }
uint32_t harness_interrupts(void) { return interrupts; }

int harness_initialize(void) {
  if (runtime) return -1;
  runtime = JS_NewRuntime();
  if (!runtime) return -2;
  JS_SetMemoryLimit(runtime, 48 * 1024 * 1024);
  /* QuickJS disables its stack check under Emscripten. The build checks every
     Wasm stack-pointer assignment against the reserved C stack instead. */
  JS_SetInterruptHandler(runtime, interrupted, NULL);
  JS_SetModuleLoaderFunc(runtime, NULL, deny_module, NULL);
  context = JS_NewContext(runtime);
  return context ? 0 : -3;
}

int harness_evaluate(uint32_t length) {
  output_length = 0;
  interrupts = 0;
  if (!context || !length || length > SOURCE_MAX) return -1;
  source[length] = 0;
  JSValue value = JS_Eval(context, (char *)source, length, "input.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(value)) {
    JS_FreeValue(context, JS_GetException(context));
    return -2;
  }
  JSValue encoded = JS_JSONStringify(context, value, JS_UNDEFINED, JS_UNDEFINED);
  JS_FreeValue(context, value);
  if (JS_IsException(encoded)) {
    JS_FreeValue(context, JS_GetException(context));
    return -3;
  }
  size_t bytes = 0;
  const char *text = JS_ToCStringLen(context, &bytes, encoded);
  JS_FreeValue(context, encoded);
  if (!text) {
    JS_FreeValue(context, JS_GetException(context));
    return -4;
  }
  if (bytes > OUTPUT_MAX) {
    JS_FreeCString(context, text);
    return -5;
  }
  memcpy(output, text, bytes);
  output_length = (uint32_t)bytes;
  JS_FreeCString(context, text);
  return 0;
}

int harness_jobs(void) {
  for (int count = 0; count < 32; count++) {
    JSContext *job_context = NULL;
    int result = JS_ExecutePendingJob(runtime, &job_context);
    if (result < 0) {
      if (job_context) JS_FreeValue(job_context, JS_GetException(job_context));
      return -1;
    }
    if (!result) return count;
  }
  return 32;
}

void harness_dispose(void) {
  if (context) JS_FreeContext(context);
  if (runtime) JS_FreeRuntime(runtime);
  context = NULL;
  runtime = NULL;
}

static JSValue bridge;
static JSValue module_namespace;
static JSValue module_promise;
static int bridge_live;
static int module_live;

int harness_bridge_initialize(uint32_t length) {
  if (!context || bridge_live || !length || length > SOURCE_MAX) return -1;
  source[length] = 0;
  bridge = JS_Eval(context, (char *)source, length, "trusted-bridge.js", JS_EVAL_TYPE_GLOBAL);
  if (JS_IsException(bridge)) {
    JS_FreeValue(context, JS_GetException(context));
    return -2;
  }
  if (!JS_IsObject(bridge)) {
    JS_FreeValue(context, bridge);
    return -3;
  }
  bridge_live = 1;
  return 0;
}

int harness_module_load(uint32_t length) {
  if (!bridge_live || module_live || !length || length > SOURCE_MAX) return -1;
  source[length] = 0;
  JSValue compiled = JS_Eval(context, (char *)source, length, "plugin.mjs",
                             JS_EVAL_TYPE_MODULE | JS_EVAL_FLAG_COMPILE_ONLY);
  if (JS_IsException(compiled)) {
    JS_FreeValue(context, JS_GetException(context));
    return -2;
  }
  JSValue retained = JS_DupValue(context, compiled);
  module_promise = JS_EvalFunction(context, compiled);
  if (JS_IsException(module_promise)) {
    JS_FreeValue(context, retained);
    JS_FreeValue(context, JS_GetException(context));
    return -3;
  }
  /* Namespace exports need the var refs installed by module linking. */
  module_namespace = JS_GetModuleNamespace(context, JS_VALUE_GET_PTR(retained));
  JS_FreeValue(context, retained);
  if (JS_IsException(module_namespace)) {
    JS_FreeValue(context, module_promise);
    JS_FreeValue(context, JS_GetException(context));
    return -4;
  }
  module_live = 1;
  return 0;
}

int harness_module_status(void) {
  return module_live ? JS_PromiseState(context, module_promise) : -1;
}

int harness_bridge_call(uint32_t operation, uint32_t length) {
  static const char *const names[] = {"initialize", "invoke", "deliver", "poll", "cancel"};
  output_length = 0;
  if (!bridge_live || operation >= 5 || length > OUTPUT_MAX) return -1;
  JSValue function = JS_GetPropertyStr(context, bridge, names[operation]);
  JSValue argument = JS_NewStringLen(context, (char *)source, length);
  if (JS_IsException(argument)) {
    JS_FreeValue(context, function);
    JS_FreeValue(context, JS_GetException(context));
    return -2;
  }
  JSValue arguments[2] = {argument, JS_UNDEFINED};
  int argc = 1;
  if (operation == 0) {
    if (!module_live || JS_PromiseState(context, module_promise) != JS_PROMISE_FULFILLED) {
      JS_FreeValue(context, function);
      JS_FreeValue(context, argument);
      return -3;
    }
    arguments[1] = argument;
    arguments[0] = JS_GetPropertyStr(context, module_namespace, "createIntegrationProvider");
    argc = 2;
  }
  JSValue value = JS_Call(context, function, bridge, argc, arguments);
  JS_FreeValue(context, function);
  JS_FreeValue(context, argument);
  if (argc == 2) JS_FreeValue(context, arguments[0]);
  if (JS_IsException(value)) {
    JS_FreeValue(context, JS_GetException(context));
    return -4;
  }
  if (operation == 3 && JS_IsString(value)) {
    size_t bytes = 0;
    const char *text = JS_ToCStringLen(context, &bytes, value);
    if (!text || bytes > OUTPUT_MAX) {
      if (text) JS_FreeCString(context, text);
      else JS_FreeValue(context, JS_GetException(context));
      JS_FreeValue(context, value);
      return -5;
    }
    memcpy(output, text, bytes);
    output_length = (uint32_t)bytes;
    JS_FreeCString(context, text);
  }
  JS_FreeValue(context, value);
  return 0;
}

void harness_bridge_dispose(void) {
  if (module_live) {
    JS_FreeValue(context, module_namespace);
    JS_FreeValue(context, module_promise);
  }
  if (bridge_live) JS_FreeValue(context, bridge);
  module_live = bridge_live = 0;
  harness_dispose();
}
