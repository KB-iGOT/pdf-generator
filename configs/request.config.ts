import { AxiosRequestConfig } from './axios-request-config.model'

const TIMEOUT = 10000

export const axiosRequestConfig: AxiosRequestConfig = {
  retry: 0,
  retryDelay: 1,
  timeout: Number(TIMEOUT) || 10000,
}

export const axiosRequestConfigLong: AxiosRequestConfig = {
  retry: 3,
  retryDelay: 1,
  timeout: 20000,
}

export const axiosRequestConfigVeryLong: AxiosRequestConfig = {
  retry: 1,
  retryDelay: 1,
  timeout: 200000,
}
