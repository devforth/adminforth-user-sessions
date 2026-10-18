<template>
  <div class="af-user-sessions">
    <SessionsTable
      :title="$t('Active sessions')"
      :description="$t('Every browser you signed in from has its own session. Revoke the ones you do not recognize.')"
    />
  </div>
</template>

<script setup lang="ts">
import SessionsTable from './SessionsTable.vue';
</script>
