import { styled } from '@linaria/react'

export const TranscriptionForm = styled.form`
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
  margin: 24px 0;
  input {
    max-width: 100%;
  }
  section {
    width: 100%;
  }
  pre {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  [role='alert'] {
    color: #a12c2c;
  }
`
