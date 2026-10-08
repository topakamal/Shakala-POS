<script setup lang="ts">
import { computed } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { cn } from '@/lib/utils'
import { primaryNavItems, isNavActive } from './navItems'
import { useAccountStore } from '@/stores/account'

const route = useRoute()
const account = useAccountStore()
const visiblePrimaryNavItems = computed(() => primaryNavItems.filter((item) => {
  if (item.to === '/cashflow') return account.hasPermission('cashflow')
  if (item.to === '/settings') return account.hasPermission('settings')
  return account.hasPermission('cashier')
}))
</script>

<template>
  <nav
    class="sticky bottom-0 z-30 grid grid-cols-5 border-t border-border bg-card/95 backdrop-blur pb-[env(safe-area-inset-bottom)] md:hidden"
  >
    <RouterLink
      v-for="item in visiblePrimaryNavItems"
      :key="item.to"
      :to="item.to"
      class="flex flex-col items-center justify-center gap-1 py-2.5 text-[11px] font-medium transition-colors"
      :class="
        cn(
          isNavActive(route.path, item)
            ? 'text-primary'
            : 'text-muted-foreground hover:text-foreground',
        )
      "
    >
      <component :is="item.icon" class="size-5" />
      <span>{{ item.label }}</span>
    </RouterLink>
  </nav>
</template>
