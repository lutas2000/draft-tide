// Who is on the other end of the Engine's Unix-domain socket (macOS)?
//
// The kernel reports the peer's audit token (getsockopt LOCAL_PEERTOKEN). The
// token names one process *instance*: its pidversion changes on exec, unlike a
// bare pid. We turn it into a SecCode and check a code-signing requirement.
//
// Two facts from the desktop-auth spike shape how the Engine uses this:
// the token describes whoever *last used* the socket, and it is computed when
// queried. So a single check can be passed by a process that sends and then
// execs the real app. The Engine therefore pins the instance at hello, sends a
// nonce, and accepts only an echo (and every later message) from that same
// instance. See docs/desktop-auth-spike.md.
//
// Built with clang directly (no node-gyp): scripts/build.ts.
#include <node_api.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/ucred.h>
#include <bsm/libbsm.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>

#ifndef LOCAL_PEERTOKEN
#define LOCAL_PEERTOKEN 0x006
#endif

static void set_int(napi_env env, napi_value obj, const char *key, int64_t n) {
  napi_value v;
  napi_create_int64(env, n, &v);
  napi_set_named_property(env, obj, key, v);
}

static void set_bool(napi_env env, napi_value obj, const char *key, bool b) {
  napi_value v;
  napi_get_boolean(env, b, &v);
  napi_set_named_property(env, obj, key, v);
}

static void set_cfstr(napi_env env, napi_value obj, const char *key, CFStringRef s) {
  napi_value v;
  char buf[512];
  if (s && CFStringGetCString(s, buf, sizeof buf, kCFStringEncodingUTF8)) napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &v);
  else napi_get_null(env, &v);
  napi_set_named_property(env, obj, key, v);
}

static int arg_fd(napi_env env, napi_callback_info info, size_t want, napi_value *argv) {
  size_t argc = want;
  if (napi_get_cb_info(env, info, &argc, argv, NULL, NULL) != napi_ok || argc < want) return -1;
  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok) return -1;
  return fd;
}

static int peer_token(int fd, audit_token_t *tok) {
  socklen_t len = sizeof(*tok);
  return getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, tok, &len);
}

// peerInstance(fd) -> { pid, pidversion, euid }
static napi_value peer_instance(napi_env env, napi_callback_info info) {
  napi_value argv[1];
  int fd = arg_fd(env, info, 1, argv);
  if (fd < 0) { napi_throw_type_error(env, NULL, "fd required"); return NULL; }
  audit_token_t tok;
  if (peer_token(fd, &tok) != 0) { napi_throw_error(env, NULL, "LOCAL_PEERTOKEN failed"); return NULL; }
  napi_value out;
  napi_create_object(env, &out);
  set_int(env, out, "pid", audit_token_to_pid(tok));
  set_int(env, out, "pidversion", audit_token_to_pidversion(tok));
  set_int(env, out, "euid", audit_token_to_euid(tok));
  return out;
}

// checkRequirement(fd, requirement) -> { valid, status, identifier, teamId, pid, pidversion }
// The instance fields come from the same token the check used.
static napi_value check_requirement(napi_env env, napi_callback_info info) {
  napi_value argv[2];
  int fd = arg_fd(env, info, 2, argv);
  if (fd < 0) { napi_throw_type_error(env, NULL, "fd and requirement required"); return NULL; }
  size_t len = 0;
  if (napi_get_value_string_utf8(env, argv[1], NULL, 0, &len) != napi_ok || len == 0 || len > 4096) {
    napi_throw_type_error(env, NULL, "requirement must be a non-empty string");
    return NULL;
  }
  char *req_str = (char *)malloc(len + 1);
  napi_get_value_string_utf8(env, argv[1], req_str, len + 1, &len);

  audit_token_t tok;
  if (peer_token(fd, &tok) != 0) { free(req_str); napi_throw_error(env, NULL, "LOCAL_PEERTOKEN failed"); return NULL; }

  napi_value out;
  napi_create_object(env, &out);
  set_int(env, out, "pid", audit_token_to_pid(tok));
  set_int(env, out, "pidversion", audit_token_to_pidversion(tok));
  set_bool(env, out, "valid", false);

  CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&tok, sizeof tok);
  const void *keys[] = { kSecGuestAttributeAudit };
  const void *vals[] = { data };
  CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, vals, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  OSStatus st = SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code);
  CFRelease(attrs);
  CFRelease(data);
  if (st != errSecSuccess || !code) {
    set_int(env, out, "status", st);
    free(req_str);
    return out;
  }

  SecStaticCodeRef sc = NULL;
  if (SecCodeCopyStaticCode(code, kSecCSDefaultFlags, &sc) == errSecSuccess && sc) {
    CFDictionaryRef si = NULL;
    if (SecCodeCopySigningInformation(sc, kSecCSSigningInformation, &si) == errSecSuccess && si) {
      set_cfstr(env, out, "identifier", (CFStringRef)CFDictionaryGetValue(si, kSecCodeInfoIdentifier));
      set_cfstr(env, out, "teamId", (CFStringRef)CFDictionaryGetValue(si, kSecCodeInfoTeamIdentifier));
      CFRelease(si);
    }
    CFRelease(sc);
  }

  CFStringRef rs = CFStringCreateWithCString(NULL, req_str, kCFStringEncodingUTF8);
  free(req_str);
  SecRequirementRef req = NULL;
  OSStatus rst = rs ? SecRequirementCreateWithString(rs, kSecCSDefaultFlags, &req) : errSecParam;
  if (rs) CFRelease(rs);
  if (rst != errSecSuccess) {
    set_int(env, out, "status", rst);
  } else {
    OSStatus vst = SecCodeCheckValidity(code, kSecCSDefaultFlags, req);
    set_int(env, out, "status", vst);
    set_bool(env, out, "valid", vst == errSecSuccess);
    CFRelease(req);
  }
  CFRelease(code);
  return out;
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "peerInstance", NULL, peer_instance, NULL, NULL, NULL, napi_default, NULL },
    { "checkRequirement", NULL, check_requirement, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
