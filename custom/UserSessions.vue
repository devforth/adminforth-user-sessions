<template>
  <div class="af-user-sessions flex flex-col justify-center mr-6 md:mr-12">
    <SessionsTable>
      <template #heading>
        <div>
          <h2 class="text-3xl font-semibold leading-none text-gray-800 dark:text-gray-50">
            {{ $t('Active sessions') }}
          </h2>
          <p class="mt-3 text-sm text-gray-600 dark:text-gray-300">
            {{ $t('Every browser you signed in from has its own session. Revoke the ones you do not recognize.') }}
          </p>
        </div>
      </template>
    </SessionsTable>
  </div>
</template>

<script setup lang="ts">
import SessionsTable from './SessionsTable.vue';
</script>
