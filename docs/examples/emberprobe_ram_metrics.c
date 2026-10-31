#include <stdint.h>

/* Keep these global symbols in the final ELF and update them from your own
 * allocator/RTOS instrumentation. A zero total means data is unavailable. */
volatile uint32_t emberprobe_ram_used_bytes = 0;
volatile uint32_t emberprobe_ram_total_bytes = 0;

void EmberProbe_ReportRamUsage(uint32_t used_bytes, uint32_t total_bytes)
{
    if (total_bytes == 0U || used_bytes > total_bytes) {
        emberprobe_ram_total_bytes = 0U;
        return;
    }
    emberprobe_ram_used_bytes = used_bytes;
    emberprobe_ram_total_bytes = total_bytes;
}
