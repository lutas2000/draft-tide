// N-API addon: a generic password in the user's login keychain, through the
// Security framework in-process. In-process matters: the keychain decides who
// may read an item by the code signature of the calling process, so going
// through /usr/bin/security would make `security` the reader.
//
//   store(service, account, data: Buffer) -> OSStatus
//   read(service, account, allowUI: boolean) -> { status, message, data? }
//   remove(service, account) -> OSStatus
//
// With allowUI false the read must never show a dialog: an item whose access
// list doesn't trust the caller fails with errSecInteractionNotAllowed
// (-25308) instead of asking the user.
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <node_api.h>
#include <stdlib.h>
#include <string.h>

#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static char *arg_string(napi_env env, napi_value v) {
  size_t n = 0;
  if (napi_get_value_string_utf8(env, v, NULL, 0, &n) != napi_ok) return NULL;
  char *s = malloc(n + 1);
  napi_get_value_string_utf8(env, v, s, n + 1, &n);
  return s;
}

static CFMutableDictionaryRef item_query(const char *service, const char *account) {
  CFMutableDictionaryRef q = CFDictionaryCreateMutable(NULL, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFDictionarySetValue(q, kSecClass, kSecClassGenericPassword);
  CFStringRef s = CFStringCreateWithCString(NULL, service, kCFStringEncodingUTF8);
  CFStringRef a = CFStringCreateWithCString(NULL, account, kCFStringEncodingUTF8);
  CFDictionarySetValue(q, kSecAttrService, s);
  CFDictionarySetValue(q, kSecAttrAccount, a);
  CFRelease(s);
  CFRelease(a);
  return q;
}

static napi_value status_value(napi_env env, OSStatus st) {
  napi_value v;
  napi_create_int32(env, st, &v);
  return v;
}

static void set_message(napi_env env, napi_value obj, OSStatus st) {
  char buf[256] = "";
  CFStringRef msg = SecCopyErrorMessageString(st, NULL);
  if (msg) {
    CFStringGetCString(msg, buf, sizeof buf, kCFStringEncodingUTF8);
    CFRelease(msg);
  }
  napi_value v;
  napi_create_string_utf8(env, buf, NAPI_AUTO_LENGTH, &v);
  napi_set_named_property(env, obj, "message", v);
}

static napi_value store(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *service = arg_string(env, argv[0]);
  char *account = arg_string(env, argv[1]);
  void *bytes = NULL;
  size_t len = 0;
  napi_get_buffer_info(env, argv[2], &bytes, &len);
  CFMutableDictionaryRef q = item_query(service, account);
  CFDataRef data = CFDataCreate(NULL, bytes, (CFIndex)len);
  CFDictionarySetValue(q, kSecValueData, data);
  CFDictionarySetValue(q, kSecAttrLabel, CFSTR("Draft Tide token-custody spike"));
  // No kSecAttrAccess: the default access list trusts only the calling
  // application, identified by its designated requirement.
  OSStatus st = SecItemAdd(q, NULL);
  CFRelease(data);
  CFRelease(q);
  free(service);
  free(account);
  return status_value(env, st);
}

static napi_value read_item(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *service = arg_string(env, argv[0]);
  char *account = arg_string(env, argv[1]);
  bool allow_ui = false;
  napi_get_value_bool(env, argv[2], &allow_ui);
  CFMutableDictionaryRef q = item_query(service, account);
  CFDictionarySetValue(q, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(q, kSecMatchLimit, kSecMatchLimitOne);
  if (!allow_ui) {
    CFDictionarySetValue(q, kSecUseAuthenticationUI, kSecUseAuthenticationUIFail);
    SecKeychainSetUserInteractionAllowed(false);
  }
  CFTypeRef result = NULL;
  OSStatus st = SecItemCopyMatching(q, &result);
  if (!allow_ui) SecKeychainSetUserInteractionAllowed(true);
  CFRelease(q);
  free(service);
  free(account);

  napi_value out;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "status", status_value(env, st));
  set_message(env, out, st);
  if (st == errSecSuccess && result && CFGetTypeID(result) == CFDataGetTypeID()) {
    CFDataRef d = (CFDataRef)result;
    void *copy = NULL;
    napi_value buf;
    napi_create_buffer_copy(env, (size_t)CFDataGetLength(d), CFDataGetBytePtr(d), &copy, &buf);
    napi_set_named_property(env, out, "data", buf);
  }
  if (result) CFRelease(result);
  return out;
}

static napi_value remove_item(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, NULL, NULL);
  char *service = arg_string(env, argv[0]);
  char *account = arg_string(env, argv[1]);
  CFMutableDictionaryRef q = item_query(service, account);
  OSStatus st = SecItemDelete(q);
  CFRelease(q);
  free(service);
  free(account);
  return status_value(env, st);
}

static napi_value init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    { "store", NULL, store, NULL, NULL, NULL, napi_default, NULL },
    { "read", NULL, read_item, NULL, NULL, NULL, napi_default, NULL },
    { "remove", NULL, remove_item, NULL, NULL, NULL, napi_default, NULL },
  };
  napi_define_properties(env, exports, sizeof props / sizeof props[0], props);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, init)
