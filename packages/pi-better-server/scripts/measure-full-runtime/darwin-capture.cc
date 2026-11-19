#include <node_api.h>
#ifdef __APPLE__
#include <libproc.h>
#include <mach/mach_time.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <uuid/uuid.h>
#endif
#include <stdint.h>
#include <time.h>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstring>
#include <limits>
#include <string>

static napi_value Text(napi_env env, const std::string& value) {
  napi_value result; napi_create_string_utf8(env, value.c_str(), value.size(), &result); return result;
}
static void Put(napi_env env, napi_value target, const char* name, napi_value value) {
  napi_set_named_property(env, target, name, value);
}
// Both domains include time spent suspended; a sleep is a real capture gap.
static napi_value ContinuousNs(napi_env env, napi_callback_info) {
#ifdef __APPLE__
  mach_timebase_info_data_t scale{};
  if (mach_timebase_info(&scale) != KERN_SUCCESS || !scale.denom) {
    napi_throw_error(env, nullptr, "Continuous Mach clock unavailable"); return nullptr;
  }
  const auto ns = static_cast<uint64_t>(static_cast<__uint128_t>(mach_continuous_time()) * scale.numer / scale.denom);
#else
  timespec value{};
  if (clock_gettime(CLOCK_BOOTTIME, &value) != 0) {
    napi_throw_error(env, nullptr, "CLOCK_BOOTTIME unavailable"); return nullptr;
  }
  const auto ns = static_cast<uint64_t>(value.tv_sec) * 1000000000ULL + value.tv_nsec;
#endif
  return Text(env, std::to_string(ns));
}

#ifdef __APPLE__
static napi_value Number(napi_env env, double value) {
  napi_value result; napi_create_double(env, value, &result); return result;
}
static bool PutClock(napi_env env, napi_value target, const char* name, const char* rawName) {
  timespec value{};
  if (clock_gettime(CLOCK_REALTIME, &value) != 0) {
    napi_throw_error(env, nullptr, "Native realtime clock unavailable"); return false;
  }
  Put(env, target, name, Number(env, std::floor(value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0)));
  Put(env, target, rawName, Text(env, std::to_string(static_cast<uint64_t>(value.tv_sec) * 1000000000ULL + value.tv_nsec)));
  return true;
}
static napi_value Capture(napi_env env, napi_callback_info info) {
  const auto started = ContinuousNs(env, nullptr);
  if (!started) return nullptr;
  size_t argc = 1; napi_value args[1]; napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  bool array = false;
  if (argc != 1 || napi_is_array(env, args[0], &array) != napi_ok || !array) {
    napi_throw_type_error(env, nullptr, "Owned PID array required"); return nullptr;
  }
  uint32_t length = 0; napi_get_array_length(env, args[0], &length);
  if (!length || length > 4096) { napi_throw_range_error(env, nullptr, "Invalid PID batch size"); return nullptr; }
  mach_timebase_info_data_t scale{};
  if (mach_timebase_info(&scale) != KERN_SUCCESS || !scale.denom) {
    napi_throw_error(env, nullptr, "Kernel clock identity unavailable"); return nullptr;
  }
  // KERN_BOOTTIME can move when the wall clock is adjusted within one boot.
  uuid_string_t boot{};
  size_t bootSize = sizeof(boot);
  uuid_t parsedBoot{};
  if (sysctlbyname("kern.bootsessionuuid", boot, &bootSize, nullptr, 0) != 0 ||
      bootSize != sizeof(boot) || boot[sizeof(boot) - 1] != '\0' ||
      uuid_parse(boot, parsedBoot) != 0 || uuid_is_null(parsedBoot)) {
    napi_throw_error(env, nullptr, "Kernel boot session UUID unavailable"); return nullptr;
  }
  napi_value result, records;
  napi_create_object(env, &result); napi_create_array_with_length(env, length, &records);
  if (!PutClock(env, result, "captureStartedAt", "captureStartedNs")) return nullptr;
  for (uint32_t index = 0; index < length; index++) {
    napi_value input; napi_get_element(env, args[0], index, &input);
    double value = 0;
    if (napi_get_value_double(env, input, &value) != napi_ok || !std::isfinite(value) || value < 1 || value > INT_MAX || std::floor(value) != value) {
      napi_throw_range_error(env, nullptr, "Invalid owned PID"); return nullptr;
    }
    rusage_info_v0 usage{};
    if (proc_pid_rusage(static_cast<int>(value), RUSAGE_INFO_V0, reinterpret_cast<rusage_info_t*>(&usage)) != 0) {
      napi_throw_error(env, nullptr, std::strerror(errno)); return nullptr;
    }
    if (usage.ri_proc_exit_abstime || !usage.ri_proc_start_abstime) {
      napi_throw_error(env, nullptr, "Exited or unidentified process in capture"); return nullptr;
    }
    napi_value record, identity, cpu;
    napi_create_object(env, &record); napi_create_object(env, &identity); napi_create_object(env, &cpu);
    Put(env, identity, "pid", Number(env, value));
    Put(env, identity, "start", Text(env, std::to_string(usage.ri_proc_start_abstime)));
    Put(env, identity, "boot", Text(env, boot));
    // XNU fill_task_rusage copies task_power_info's Mach-time counters.
    const long double ticks = static_cast<long double>(usage.ri_user_time) + usage.ri_system_time;
    Put(env, cpu, "totalMicros", Number(env, static_cast<double>(ticks * scale.numer / scale.denom / 1000.0L)));
    Put(env, record, "identity", identity); Put(env, record, "cpu", cpu);
    Put(env, record, "rss", Number(env, static_cast<double>(usage.ri_resident_size)));
    if (!PutClock(env, record, "observedAt", "observedAtNs")) return nullptr;
    const auto observed = ContinuousNs(env, nullptr);
    if (!observed) return nullptr;
    Put(env, record, "observedContinuousNs", observed);
    napi_set_element(env, records, index, record);
  }
  Put(env, result, "records", records);
  if (!PutClock(env, result, "capturedAt", "capturedNs")) return nullptr;
  const auto ended = ContinuousNs(env, nullptr);
  if (!ended) return nullptr;
  Put(env, result, "captureStartedContinuousNs", started);
  Put(env, result, "capturedContinuousNs", ended);
  Put(env, result, "cpuResolutionMs", Number(env, static_cast<double>(scale.numer) / scale.denom / 1000000.0));
  return result;
}
#endif
static napi_value Init(napi_env env, napi_value exports) {
  napi_value clock; napi_create_function(env, "continuousNs", NAPI_AUTO_LENGTH, ContinuousNs, nullptr, &clock);
  Put(env, exports, "continuousNs", clock);
#ifdef __APPLE__
  napi_value capture; napi_create_function(env, "capture", NAPI_AUTO_LENGTH, Capture, nullptr, &capture);
  Put(env, exports, "capture", capture);
#endif
  return exports;
}
NAPI_MODULE(darwin_capture, Init)
