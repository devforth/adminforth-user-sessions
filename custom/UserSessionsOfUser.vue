<template>
  <div class="mt-6">
    <SessionsTable
      :userPk="userPk"
      :title="$t('Active sessions')"
      :description="$t('Browsers this user is signed in from.')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import SessionsTable from './SessionsTable.vue';

const props = defineProps<{
  record: Record<string, any>;
  meta: { primaryKeyField: string };
}>();

const userPk = computed(() => String(props.record[props.meta.primaryKeyField]));
</script>
